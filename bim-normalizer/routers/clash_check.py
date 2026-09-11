import asyncio
import logging
import uuid
from concurrent.futures.process import BrokenProcessPool

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget
from process_pool import run_cpu_bound
from routers.ifc_export import resolve_model_ifc_bytes, build_revit_guid_map

router = APIRouter(tags=["clash-check"])
logger = logging.getLogger(__name__)

# Starting element-count of each retry batch once a rule's worker has
# segfaulted on the whole-job AND the single-rule attempt (see
# clash_check.py's _single_threaded_geometry_iterator docstring — a real,
# still-occurring native ifcopenshell crash under certain geometry, not the
# threading race that mitigation targets, so run_cpu_bound's built-in one
# retry doesn't save it). A batch that still crashes gets bisected by
# _bisect_ids below rather than discarded whole, so this only bounds how
# many top-level chunks get created up front, not how finely a genuinely
# poisoned one gets split.
_CRASH_BATCH_SIZE = 200


def _chunked(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


async def _bisect_ids(
    run_one_batch, rule: dict, ids: list[str], chunk_is_a: bool, other_selector: str, on_progress,
) -> tuple[list[dict], list[str]]:
    """
    Run `rule` with `ids` substituted into whichever side chunk_is_a selects
    (the other side held fixed to other_selector), via run_one_batch(rule) —
    an async callable that returns that one rule's result dict or raises
    BrokenProcessPool on a double-crash (run_cpu_bound's own automatic retry
    already failed too).

    On a double-crash, bisects `ids` in half and recurses instead of
    discarding the whole slice. This matters because the previous flat
    per-batch handling discarded an entire _CRASH_BATCH_SIZE-sized batch the
    moment ANY element in it crashed — confirmed in production on a
    real cross-model check where exactly one duct segment (out of 1457,
    paired with one specific slab) crashed the native geometry kernel, and
    the old code's response was to mark all 1457 as crashed_global_ids and
    return zero real results, discarding 1456 elements' worth of legitimate
    clash results along with the one actually-poisoned pairing. Bisecting
    isolates just the element(s) that actually crash.

    Base case: a lone element that still crashes alone is genuinely poison
    and gets recorded as crashed rather than retried further.

    on_progress(n) fires once per n ids that reach a final (resolved or
    crashed) outcome, so callers can report real progress through a
    bisection instead of the job looking stuck at 0% for its whole
    duration — see routers/clash_check.py's _report_progress.
    """
    selector = ", ".join(ids)
    batch_rule = {
        **rule,
        "selector_a": selector if chunk_is_a else other_selector,
        "selector_b": other_selector if chunk_is_a else selector,
    }
    try:
        result = await run_one_batch(batch_rule)
        on_progress(len(ids))
        return result["clashes"], []
    except BrokenProcessPool:
        if len(ids) == 1:
            logger.error(
                "Clash job: element %s crashes the clash computation itself — skipping just this element",
                ids[0],
            )
            on_progress(1)
            return [], list(ids)
        mid = len(ids) // 2
        left_clashes, left_crashed = await _bisect_ids(
            run_one_batch, rule, ids[:mid], chunk_is_a, other_selector, on_progress,
        )
        right_clashes, right_crashed = await _bisect_ids(
            run_one_batch, rule, ids[mid:], chunk_is_a, other_selector, on_progress,
        )
        return left_clashes + right_clashes, left_crashed + right_crashed


def _report_progress(job_id: str, completed: int | float, total: int) -> None:
    """Progress checkpoint for the per-rule/per-batch fallback loops below —
    these run in the main process (unlike clash_check.py's own
    _report_progress, called from inside a worker for the common whole-job-
    in-one-call path), so a plain update_job() with a connection from this
    process's own pool is enough; no cross-process DB access needed here.
    completed is a whole number of rules done except while a rule is being
    bisected after a crash (see _bisect_ids) — for that rule's duration it's
    fractional, e.g. 1.35, so progress keeps moving instead of sitting at
    the last whole-rule count for however long the bisection takes."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        update_job(conn, job_id, result={"progress": {"completed": completed, "total": total}})
    finally:
        release_conn(conn)


async def _run_clash_checks_resilient(
    ifc_bytes: bytes, rule_dicts: list[dict], resolve_application_ids: bool, guid_map: dict, job_id: str,
) -> list[dict]:
    """
    Same-model counterpart of run_clash_checks, with a degraded fallback for
    when a rule's worker segfaults even after run_cpu_bound's own retry.
    Falls back per-rule (not per-job) so one bad rule doesn't lose results
    for the others, then — for genuinely two-sided rules only — per-batch,
    so one bad element doesn't lose the whole rule.

    A two-sided rule (selector_b set and different from selector_a) is
    batchable without losing correctness: split whichever side has more
    elements into GlobalId-selector batches of _CRASH_BATCH_SIZE, and run
    each batch against the OTHER side kept whole, so every batch still sees
    every possible clash partner — it just costs rebuilding the untouched
    side's BVH tree once per batch. A batch that crashes twice (its own
    run_cpu_bound retry included) is skipped and its GlobalIds recorded in
    the result's `crashed_global_ids` rather than losing the whole rule.

    Self-clash rules (no selector_b, or selector_b == selector_a) aren't
    batchable this way — splitting the one group into chunks and checking
    each chunk only against itself would silently miss any clash between two
    elements that land in different chunks. Those get one extra whole-rule
    retry and, if that still crashes, are reported with `crashed: True` and
    no partial results, same as a total failure would have looked before
    this fallback existed.
    """
    from clash_check import run_clash_checks, resolve_selector_global_ids

    try:
        return await run_cpu_bound(
            run_clash_checks, ifc_bytes, rule_dicts, resolve_application_ids, guid_map, job_id,
        )
    except BrokenProcessPool:
        logger.warning("Clash job: whole-job run crashed twice, falling back to per-rule retry")

    results = []
    for rule in rule_dicts:
        try:
            results.append((await run_cpu_bound(
                run_clash_checks, ifc_bytes, [rule], resolve_application_ids, guid_map,
            ))[0])
            _report_progress(job_id, len(results), len(rule_dicts))
            continue
        except BrokenProcessPool:
            logger.warning("Clash job: rule %r crashed twice alone too", rule.get("name"))

        selector_a = rule["selector_a"]
        selector_b = rule.get("selector_b")
        if not selector_b or selector_b == selector_a:
            results.append({
                "name": rule.get("name"), "mode": rule.get("mode", "collision"),
                "selector_a": selector_a, "selector_b": selector_b,
                "count": 0, "clashes": [], "crashed": True,
            })
            _report_progress(job_id, len(results), len(rule_dicts))
            continue

        try:
            ids_a = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes, selector_a)
            ids_b = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes, selector_b)
        except BrokenProcessPool:
            logger.error(
                "Clash job: rule %r crashed resolving element ids for batching too — giving up on this rule",
                rule.get("name"),
            )
            results.append({
                "name": rule.get("name"), "mode": rule.get("mode", "collision"),
                "selector_a": selector_a, "selector_b": selector_b,
                "count": 0, "clashes": [], "crashed": True,
            })
            _report_progress(job_id, len(results), len(rule_dicts))
            continue
        chunk_is_a = len(ids_a) >= len(ids_b)
        big_ids = ids_a if chunk_is_a else ids_b
        other_selector = selector_b if chunk_is_a else selector_a

        total_elements = len(big_ids)
        resolved_elements = 0

        def _on_progress(n: int) -> None:
            nonlocal resolved_elements
            resolved_elements += n
            _report_progress(job_id, round(len(results) + resolved_elements / total_elements, 2), len(rule_dicts))

        async def _run_one_batch(batch_rule: dict) -> dict:
            return (await run_cpu_bound(
                run_clash_checks, ifc_bytes, [batch_rule], resolve_application_ids, guid_map,
            ))[0]

        merged_clashes = []
        crashed_ids: list[str] = []
        for batch_ids in _chunked(big_ids, _CRASH_BATCH_SIZE):
            batch_clashes, batch_crashed = await _bisect_ids(
                _run_one_batch, rule, batch_ids, chunk_is_a, other_selector, _on_progress,
            )
            merged_clashes.extend(batch_clashes)
            crashed_ids.extend(batch_crashed)

        results.append({
            "name": rule.get("name"), "mode": rule.get("mode", "collision"),
            "selector_a": selector_a, "selector_b": selector_b,
            "count": len(merged_clashes), "clashes": merged_clashes,
            **({"crashed_global_ids": crashed_ids} if crashed_ids else {}),
        })
        _report_progress(job_id, len(results), len(rule_dicts))
    return results


async def _run_cross_model_clash_checks_resilient(
    ifc_bytes_a: bytes, ifc_bytes_b: bytes, rule_dicts: list[dict],
    resolve_a: bool, resolve_b: bool, guid_map_a: dict, guid_map_b: dict, job_id: str,
) -> list[dict]:
    """Cross-model counterpart of _run_clash_checks_resilient — see its
    docstring for the batching rationale. Cross-model rules are always
    two-sided by construction (selector_a matches within model A,
    selector_b — or selector_a again — within model B), so every rule here
    is batchable; there's no self-clash case to special-case."""
    from clash_check import run_cross_model_clash_checks, resolve_selector_global_ids

    try:
        return await run_cpu_bound(
            run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, rule_dicts,
            resolve_a, resolve_b, guid_map_a, guid_map_b, job_id,
        )
    except BrokenProcessPool:
        logger.warning("Cross-model clash job: whole-job run crashed twice, falling back to per-rule retry")

    results = []
    for rule in rule_dicts:
        try:
            results.append((await run_cpu_bound(
                run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, [rule],
                resolve_a, resolve_b, guid_map_a, guid_map_b,
            ))[0])
            _report_progress(job_id, len(results), len(rule_dicts))
            continue
        except BrokenProcessPool:
            logger.warning("Cross-model clash job: rule %r crashed twice alone too", rule.get("name"))

        selector_a = rule["selector_a"]
        selector_b = rule.get("selector_b") or selector_a

        try:
            ids_a = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes_a, selector_a)
            ids_b = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes_b, selector_b)
        except BrokenProcessPool:
            logger.error(
                "Cross-model clash job: rule %r crashed resolving element ids for batching too — "
                "giving up on this rule", rule.get("name"),
            )
            results.append({
                "name": rule.get("name"), "mode": rule.get("mode", "collision"),
                "selector_a": selector_a, "selector_b": selector_b,
                "count": 0, "clashes": [], "crashed": True,
            })
            _report_progress(job_id, len(results), len(rule_dicts))
            continue
        chunk_is_a = len(ids_a) >= len(ids_b)
        big_ids = ids_a if chunk_is_a else ids_b
        other_selector = selector_b if chunk_is_a else selector_a

        total_elements = len(big_ids)
        resolved_elements = 0

        def _on_progress(n: int) -> None:
            nonlocal resolved_elements
            resolved_elements += n
            _report_progress(job_id, round(len(results) + resolved_elements / total_elements, 2), len(rule_dicts))

        async def _run_one_batch(batch_rule: dict) -> dict:
            return (await run_cpu_bound(
                run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, [batch_rule],
                resolve_a, resolve_b, guid_map_a, guid_map_b,
            ))[0]

        merged_clashes = []
        crashed_ids: list[str] = []
        for batch_ids in _chunked(big_ids, _CRASH_BATCH_SIZE):
            batch_clashes, batch_crashed = await _bisect_ids(
                _run_one_batch, rule, batch_ids, chunk_is_a, other_selector, _on_progress,
            )
            merged_clashes.extend(batch_clashes)
            crashed_ids.extend(batch_crashed)

        results.append({
            "name": rule.get("name"), "mode": rule.get("mode", "collision"),
            "selector_a": selector_a, "selector_b": selector_b,
            "count": len(merged_clashes), "clashes": merged_clashes,
            **({"crashed_global_ids": crashed_ids} if crashed_ids else {}),
        })
        _report_progress(job_id, len(results), len(rule_dicts))
    return results


class ClashRule(BaseModel):
    name: str | None = None
    selector_a: str
    selector_b: str | None = None
    mode: str = "collision"  # "collision" | "intersection" | "clearance"
    tolerance: float = 0.01
    clearance: float = 0.1
    allow_touching: bool = True


class ClashCheckRequest(BaseModel):
    rules: list[ClashRule]
    coord_unit: str = "mm"
    server_url: str | None = None  # overrides the model's stored ingest server, e.g. for a fresh token
    token: str | None = None       # overrides env token if provided
    # When set, runs every rule's selector_a against THIS model and
    # selector_b against compare_model_id instead of checking this model
    # against itself — the cross-discipline clash workflow (e.g. structure
    # vs architecture), as opposed to the default within-one-model check.
    compare_model_id: str | None = None


@router.post("/models/{model_id}/clash-check")
async def start_clash_check(model_id: str, body: ClashCheckRequest):
    """Start an async clash-detection job. Poll GET /clash-check/{job_id}/status for the result."""
    from db.connection import get_conn, release_conn

    if not body.rules:
        raise HTTPException(status_code=400, detail="At least one rule is required")

    job_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        create_job(conn, job_id, "clash_check", payload={
            "model_id": model_id, "compare_model_id": body.compare_model_id,
        })
        # Written up front so a client's very first poll already sees a real
        # total instead of nothing — the worker-side checkpoints (see
        # clash_check.py's _report_progress) only start arriving once IFC
        # resolution finishes and the actual rule loop begins.
        update_job(conn, job_id, result={"progress": {"completed": 0, "total": len(body.rules)}})
    finally:
        release_conn(conn)

    async def _run():
        conn2 = get_conn()
        try:
            rule_dicts = [r.model_dump() for r in body.rules]

            if body.compare_model_id:
                # Resolve both models' IFC bytes concurrently — same reasoning
                # as the single-model path below for preferring each model's
                # real original IFC over bim-normalizer's synthetic export.
                (ifc_bytes_a, ifc_source_a), (ifc_bytes_b, ifc_source_b) = await asyncio.gather(
                    resolve_model_ifc_bytes(model_id, body.token, body.server_url, body.coord_unit),
                    resolve_model_ifc_bytes(body.compare_model_id, body.token, body.server_url, body.coord_unit),
                )
                # For whichever side(s) are a real original IFC (e.g. Revit's
                # own exporter output), resolve its GlobalIds back to
                # application_id via the computed Revit UniqueId<->GlobalId
                # correlation — see build_revit_guid_map's docstring.
                guid_map_a = await build_revit_guid_map(model_id) if ifc_source_a == "original_ifc" else {}
                guid_map_b = (
                    await build_revit_guid_map(body.compare_model_id) if ifc_source_b == "original_ifc" else {}
                )
                logger.info(
                    "Clash check job %s: checking %s (%s) against %s (%s)",
                    job_id, model_id, ifc_source_a, body.compare_model_id, ifc_source_b,
                )
                results = await _run_cross_model_clash_checks_resilient(
                    ifc_bytes_a, ifc_bytes_b, rule_dicts,
                    ifc_source_a == "synthetic_export", ifc_source_b == "synthetic_export",
                    guid_map_a, guid_map_b, job_id,
                )
                total = sum(r.get("count", 0) for r in results)
                total_crashed = sum(len(r.get("crashed_global_ids", [])) for r in results)
                update_job(conn2, job_id, status="complete", result={
                    "rules": results,
                    "total_count": total,
                    "total_crashed_elements": total_crashed,
                    "ifc_source": None,
                    "compare": {
                        "model_b_id": body.compare_model_id,
                        "ifc_source_a": ifc_source_a,
                        "ifc_source_b": ifc_source_b,
                    },
                })
                logger.info(
                    "Clash check job %s complete: %d rule(s), %d total clashes%s",
                    job_id, len(results), total,
                    f", {total_crashed} elements skipped after repeated crashes" if total_crashed else "",
                )
                return

            # Prefer the real IFC file the source application produced, when
            # available — same reasoning as /ids-check: bim-normalizer's own
            # re-export assigns every element a fresh, random GlobalId
            # (ifc/export.py uses ifcopenshell.guid.new()), unrelated to the
            # element's application_id. For that synthetic-export path,
            # run_clash_checks(resolve_application_ids=True) below substitutes
            # each clash's GlobalId with the element's Tag, which ifc/export.py
            # sets to application_id — so highlighting still works. A real
            # original IFC (e.g. Revit's own exporter output) assigns its own
            # GlobalIds/Tags with no relation to application_id — for that
            # path, guid_map (built below when applicable) resolves them back
            # via the computed Revit UniqueId<->GlobalId correlation instead.
            ifc_bytes, ifc_source = await resolve_model_ifc_bytes(
                model_id, body.token, body.server_url, body.coord_unit
            )
            guid_map = await build_revit_guid_map(model_id) if ifc_source == "original_ifc" else {}

            logger.info("Clash check job %s: checking against %s (%d bytes)", job_id, ifc_source, len(ifc_bytes))
            results = await _run_clash_checks_resilient(
                ifc_bytes, rule_dicts, ifc_source == "synthetic_export", guid_map, job_id,
            )
            total = sum(r.get("count", 0) for r in results)
            total_crashed = sum(len(r.get("crashed_global_ids", [])) for r in results)
            update_job(conn2, job_id, status="complete", result={
                "rules": results,
                "total_count": total,
                "total_crashed_elements": total_crashed,
                "ifc_source": ifc_source,
                "compare": None,
            })
            logger.info(
                "Clash check job %s complete: %d rule(s), %d total clashes%s",
                job_id, len(results), total,
                f", {total_crashed} elements skipped after repeated crashes" if total_crashed else "",
            )
        except Exception as exc:
            logger.error("Clash check job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                prune_jobs(conn2, "clash_check")
            finally:
                release_conn(conn2)

    fire_and_forget(_run())
    return {"job_id": job_id, "status": "pending"}


@router.get("/models/{model_id}/clash-check/{job_id}/status")
def clash_check_status(model_id: str, job_id: str):
    """Poll a clash-detection job. Once status == 'complete', `result` holds the clash list.
    `ifc_source` indicates whether the check ran against the model's true
    original IFC file ("original_ifc") or bim-normalizer's reconstruction
    ("synthetic_export", used when no original IFC blob is attached). Either
    way, clash GlobalIds are resolved to application_id server-side so 3D
    highlighting/screenshots work — for "synthetic_export" via an exact Tag
    match, for "original_ifc" via a computed Revit UniqueId<->GlobalId
    correlation (revit_guid.py) that only covers Revit-shaped application_ids,
    so highlighting may still not resolve for non-Revit sources (e.g. Tekla).
    For a cross-model check (request had compare_model_id set), `ifc_source`
    is null and `compare` instead holds {model_b_id, ifc_source_a,
    ifc_source_b} — one ifc_source per model.
    `total_crashed_elements` is normally 0; a nonzero value means a rule hit
    the native ifcopenshell geometry crash (see clash_check.py) and one or
    more batches of elements were skipped rather than losing the whole rule
    — see each rule's own `crashed_global_ids` for which elements."""
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        job = get_job(conn, job_id)
    finally:
        release_conn(conn)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="Clash check job not found — it may have completed before a backend restart, or never existed",
        )
    full_result = job["result"] or {}
    is_complete = job["status"] == "complete"
    return {
        "job_id": job_id,
        "status": job["status"],
        "error": job["error"],
        "result": (
            {
                "rules": full_result.get("rules"),
                "total_count": full_result.get("total_count"),
                "total_crashed_elements": full_result.get("total_crashed_elements", 0),
            }
            if is_complete else None
        ),
        "ifc_source": full_result.get("ifc_source"),
        "compare": full_result.get("compare"),
        # {completed, total} rules — see clash_check.py's _report_progress and
        # this router's own copy for the fallback path. Only meaningful while
        # still running; a completed/failed job's last checkpoint is harmless
        # but stale, so the frontend should stop reading it once is_complete.
        "progress": full_result.get("progress"),
    }
