import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget
from process_pool import run_cpu_bound
from routers.ifc_export import resolve_model_ifc_bytes

router = APIRouter(tags=["clash-check"])
logger = logging.getLogger(__name__)


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
            from clash_check import run_clash_checks, run_cross_model_clash_checks

            rule_dicts = [r.model_dump() for r in body.rules]

            if body.compare_model_id:
                # Resolve both models' IFC bytes concurrently — same reasoning
                # as the single-model path below for preferring each model's
                # real original IFC over bim-normalizer's synthetic export.
                (ifc_bytes_a, ifc_source_a), (ifc_bytes_b, ifc_source_b) = await asyncio.gather(
                    resolve_model_ifc_bytes(model_id, body.token, body.server_url, body.coord_unit),
                    resolve_model_ifc_bytes(body.compare_model_id, body.token, body.server_url, body.coord_unit),
                )
                logger.info(
                    "Clash check job %s: checking %s (%s) against %s (%s)",
                    job_id, model_id, ifc_source_a, body.compare_model_id, ifc_source_b,
                )
                results = await run_cpu_bound(
                    run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, rule_dicts,
                    ifc_source_a == "synthetic_export", ifc_source_b == "synthetic_export",
                )
                total = sum(r.get("count", 0) for r in results)
                update_job(conn2, job_id, status="complete", result={
                    "rules": results,
                    "total_count": total,
                    "ifc_source": None,
                    "compare": {
                        "model_b_id": body.compare_model_id,
                        "ifc_source_a": ifc_source_a,
                        "ifc_source_b": ifc_source_b,
                    },
                })
                logger.info("Clash check job %s complete: %d rule(s), %d total clashes", job_id, len(results), total)
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
            # GlobalIds/Tags with no relation to application_id, so 3D
            # highlighting still won't resolve for that path; this is a known,
            # accepted gap (no Revit UniqueId <-> IFC GlobalId mapping exists).
            ifc_bytes, ifc_source = await resolve_model_ifc_bytes(
                model_id, body.token, body.server_url, body.coord_unit
            )

            logger.info("Clash check job %s: checking against %s (%d bytes)", job_id, ifc_source, len(ifc_bytes))
            results = await run_cpu_bound(
                run_clash_checks, ifc_bytes, rule_dicts,
                ifc_source == "synthetic_export",
            )
            total = sum(r.get("count", 0) for r in results)
            update_job(conn2, job_id, status="complete", result={
                "rules": results,
                "total_count": total,
                "ifc_source": ifc_source,
                "compare": None,
            })
            logger.info("Clash check job %s complete: %d rule(s), %d total clashes", job_id, len(results), total)
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
    ("synthetic_export", used when no original IFC blob is attached — for
    this path, clash GlobalIds are already resolved to application_id
    server-side so 3D highlighting/screenshots work; for "original_ifc",
    a real exporter's own GlobalIds have no relation to application_id, so
    highlighting won't resolve there). For a cross-model check (request had
    compare_model_id set), `ifc_source` is null and `compare` instead holds
    {model_b_id, ifc_source_a, ifc_source_b} — one ifc_source per model."""
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
            {"rules": full_result.get("rules"), "total_count": full_result.get("total_count")}
            if is_complete else None
        ),
        "ifc_source": full_result.get("ifc_source"),
        "compare": full_result.get("compare"),
    }
