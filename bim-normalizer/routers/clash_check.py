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

# Element-count of each retry batch once a rule's worker has segfaulted on
# the whole-job AND the single-rule attempt (see clash_check.py's
# _single_threaded_geometry_iterator docstring — a real, still-occurring
# native ifcopenshell crash under certain geometry, not the threading race
# that mitigation targets, so run_cpu_bound's built-in one retry doesn't
# save it). Small enough that one bad element's batch is cheap to lose.
_CRASH_BATCH_SIZE = 200


def _chunked(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


async def _run_clash_checks_resilient(
    ifc_bytes: bytes, rule_dicts: list[dict], resolve_application_ids: bool, guid_map: dict,
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
        return await run_cpu_bound(run_clash_checks, ifc_bytes, rule_dicts, resolve_application_ids, guid_map)
    except BrokenProcessPool:
        logger.warning("Clash job: whole-job run crashed twice, falling back to per-rule retry")

    results = []
    for rule in rule_dicts:
        try:
            results.append((await run_cpu_bound(
                run_clash_checks, ifc_bytes, [rule], resolve_application_ids, guid_map,
            ))[0])
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
            continue

        ids_a = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes, selector_a)
        ids_b = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes, selector_b)
        chunk_is_a = len(ids_a) >= len(ids_b)
        batches = _chunked(ids_a if chunk_is_a else ids_b, _CRASH_BATCH_SIZE)

        merged_clashes = []
        crashed_ids: list[str] = []
        for batch_ids in batches:
            batch_selector = ", ".join(batch_ids)
            batch_rule = {
                **rule,
                "selector_a": batch_selector if chunk_is_a else selector_a,
                "selector_b": selector_b if chunk_is_a else batch_selector,
            }
            try:
                batch_result = (await run_cpu_bound(
                    run_clash_checks, ifc_bytes, [batch_rule], resolve_application_ids, guid_map,
                ))[0]
                merged_clashes.extend(batch_result["clashes"])
            except BrokenProcessPool:
                logger.error(
                    "Clash job: batch of %d elements crashed twice, skipping — rule %r",
                    len(batch_ids), rule.get("name"),
                )
                crashed_ids.extend(batch_ids)

        results.append({
            "name": rule.get("name"), "mode": rule.get("mode", "collision"),
            "selector_a": selector_a, "selector_b": selector_b,
            "count": len(merged_clashes), "clashes": merged_clashes,
            **({"crashed_global_ids": crashed_ids} if crashed_ids else {}),
        })
    return results


async def _run_cross_model_clash_checks_resilient(
    ifc_bytes_a: bytes, ifc_bytes_b: bytes, rule_dicts: list[dict],
    resolve_a: bool, resolve_b: bool, guid_map_a: dict, guid_map_b: dict,
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
            resolve_a, resolve_b, guid_map_a, guid_map_b,
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
            continue
        except BrokenProcessPool:
            logger.warning("Cross-model clash job: rule %r crashed twice alone too", rule.get("name"))

        selector_a = rule["selector_a"]
        selector_b = rule.get("selector_b") or selector_a

        ids_a = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes_a, selector_a)
        ids_b = await run_cpu_bound(resolve_selector_global_ids, ifc_bytes_b, selector_b)
        chunk_is_a = len(ids_a) >= len(ids_b)
        batches = _chunked(ids_a if chunk_is_a else ids_b, _CRASH_BATCH_SIZE)

        merged_clashes = []
        crashed_ids: list[str] = []
        for batch_ids in batches:
            batch_selector = ", ".join(batch_ids)
            batch_rule = {
                **rule,
                "selector_a": batch_selector if chunk_is_a else selector_a,
                "selector_b": selector_b if chunk_is_a else batch_selector,
            }
            try:
                batch_result = (await run_cpu_bound(
                    run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, [batch_rule],
                    resolve_a, resolve_b, guid_map_a, guid_map_b,
                ))[0]
                merged_clashes.extend(batch_result["clashes"])
            except BrokenProcessPool:
                logger.error(
                    "Cross-model clash job: batch of %d elements crashed twice, skipping — rule %r",
                    len(batch_ids), rule.get("name"),
                )
                crashed_ids.extend(batch_ids)

        results.append({
            "name": rule.get("name"), "mode": rule.get("mode", "collision"),
            "selector_a": selector_a, "selector_b": selector_b,
            "count": len(merged_clashes), "clashes": merged_clashes,
            **({"crashed_global_ids": crashed_ids} if crashed_ids else {}),
        })
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
                    guid_map_a, guid_map_b,
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
                ifc_bytes, rule_dicts, ifc_source == "synthetic_export", guid_map,
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
    }
