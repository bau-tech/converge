import asyncio
import logging
import os
import tempfile
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from job_registry import _content_disposition, fire_and_forget
from process_pool import run_cpu_bound
from db.jobs import create_job, update_job, get_job, prune_jobs

router = APIRouter(tags=["ifc-export"])
logger = logging.getLogger(__name__)

_EXPORT_TMP_PREFIX = "bim_export_"
_EXPORT_TMP_PREFIX_IFCX = "bim_export_ifcx_"


def _export_temp_path(job_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"{_EXPORT_TMP_PREFIX}{job_id}.ifc")


def _export_temp_path_ifcx(job_id: str) -> str:
    return os.path.join(tempfile.gettempdir(), f"{_EXPORT_TMP_PREFIX_IFCX}{job_id}.ifcx")


def _prune_export_jobs(conn, job_type: str = "export") -> None:
    """Prune old export jobs from bim_jobs, deleting their backing temp files
    first — db.jobs.prune_jobs only deletes rows, it doesn't know about files.
    job_type distinguishes the mature IFC4X3 flow ("export") from the
    experimental IFC5/.ifcx flow ("export_ifcx") so pruning one never touches
    the other's jobs/temp files."""
    from db.jobs import JOB_KEEP
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT job_id, result->>'temp_path' FROM bim_jobs
                WHERE job_type = %s AND status IN ('complete', 'failed')
                ORDER BY created_at DESC
                OFFSET %s
                """,
                (job_type, JOB_KEEP),
            )
            stale = cur.fetchall()
    except Exception:
        conn.rollback()
        raise
    for _job_id, temp_path in stale:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError as exc:
                logger.warning("_prune_export_jobs: failed to remove temp file %s: %s", temp_path, exc)
    prune_jobs(conn, job_type)


def _load_export_data(model_id: str, coord_unit: str) -> tuple:
    """Fetch model row, elements, and parameters from DB. Runs synchronously.

    Shared by /export/ifc, ids_check.py's /ids-check, and clash_check.py's
    /clash-check — all three need the same model→IFC-ready data shape.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM bim_models WHERE model_id = %s", (model_id,))
            row = cur.fetchone()
            if not row:
                raise ValueError(f"Model {model_id} not found")
            model_row = dict(zip([d[0] for d in cur.description], row))

            cur.execute("""
                SELECT e.element_id, e.application_id, e.ifc_class, e.category,
                       e.name, e.storey, e.speckle_type,
                       g.bbox_min, g.bbox_max, g.centroid,
                       g.mesh, g.volume_m3, g.area_m2,
                       g.axis, g.footprint
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s
                ORDER BY e.storey, e.category, e.name
            """, (model_id,))
            elements = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]

            params_by_element: dict[str, list] = {}
            if elements:
                eids = [str(e["element_id"]) for e in elements]
                cur.execute("""
                    SELECT element_id::text, pset, key, value, datatype, canonical_key
                    FROM bim_parameters
                    WHERE element_id = ANY(%s::uuid[])
                    ORDER BY element_id, pset, key
                """, (eids,))
                for eid, pset, key, value, datatype, canonical_key in cur.fetchall():
                    params_by_element.setdefault(eid, []).append(
                        {"pset": pset, "key": key, "value": value, "datatype": datatype,
                         "canonical_key": canonical_key}
                    )
    finally:
        release_conn(conn)
    return model_row, elements, params_by_element


def _load_application_ids(model_id: str) -> list[str]:
    """Fetch every element's application_id for this model — the minimal
    query build_revit_guid_map() below needs, without pulling geometry/
    params like _load_export_data() does."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT application_id FROM bim_elements WHERE model_id = %s AND application_id IS NOT NULL",
                (model_id,),
            )
            return [r[0] for r in cur.fetchall()]
    finally:
        release_conn(conn)


async def build_revit_guid_map(model_id: str) -> dict[str, str]:
    """Maps a Revit-exporter IFC GlobalId -> this model's application_id,
    for whichever elements have a Revit-shaped application_id (see
    revit_guid.py). Call only when checking against a model's real
    original IFC (ifc_source == "original_ifc") — for bim-normalizer's own
    synthetic export the existing Tag-based resolution already works and
    is exact, whereas this is a computed/heuristic match. Empty dict
    (cheap no-op) for non-Revit models."""
    from revit_guid import build_guid_map

    application_ids = await asyncio.to_thread(_load_application_ids, model_id)
    return build_guid_map(application_ids)


def _load_relationships_for_export(model_id: str) -> list[dict]:
    """
    Fetch this model's bim_relationships rows (parent/room/space links — see
    db/insert.py's build_relationships()) for export_model() to emit as real
    IFC relationship entities. Kept separate from _load_export_data() so its
    other two callers (ids_check.py, clash_check.py, via
    resolve_model_ifc_bytes' fallback path) aren't forced to fetch data they
    don't need — export_model()'s relationships param defaults to None.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT element_id::text, related_id::text, relation_type
                FROM bim_relationships
                WHERE element_id IN (SELECT element_id FROM bim_elements WHERE model_id = %s)
            """, (model_id,))
            return [
                {"element_id": eid, "related_id": rid, "relation_type": rtype}
                for eid, rid, rtype in cur.fetchall()
            ]
    finally:
        release_conn(conn)


async def resolve_model_ifc_bytes(
    model_id: str, token: str | None, server_url: str | None, coord_unit: str
) -> tuple[bytes, str]:
    """
    Resolve the IFC bytes to run a check (IDS/clash) against for one model:
    prefer the real original IFC file the source application produced
    (ifc_source="original_ifc"), falling back to bim-normalizer's own
    synthetic export (ifc_source="synthetic_export") when none is attached
    or the lookup fails. Shared by ids_check.py and clash_check.py so both
    single- and cross-model checks resolve a model's bytes identically.
    """
    from db.connection import get_conn, release_conn
    from speckle.fetch import fetch_original_ifc_bytes
    from ifc.export import export_model

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id, commit_id, server_url FROM bim_models WHERE model_id = %s",
                (model_id,),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)
    stream_id, commit_id, model_server_url = row if row else (None, None, None)

    # The model may have been ingested from a different Speckle server than
    # the one configured via SPECKLE_SERVER_URL (this app supports switching
    # between multiple servers) — use whichever server it actually came
    # from, not whatever happens to be the env default, otherwise this
    # GraphQL lookup silently hits the wrong server and 404s as "Stream not
    # found".
    lookup_server_url = server_url or model_server_url
    ifc_bytes = None
    ifc_source = "synthetic_export"
    if stream_id:
        try:
            ifc_bytes = await asyncio.to_thread(
                fetch_original_ifc_bytes, stream_id, token, lookup_server_url, commit_id
            )
            if ifc_bytes is not None:
                ifc_source = "original_ifc"
        except Exception as exc:
            # A hard failure here (e.g. SPECKLE_TOKEN lacking access to this
            # stream — surfaces as "GraphQL error: Stream not found") must not
            # crash the whole job — fall back to the synthetic export the
            # same as a clean "no original" result.
            logger.warning(
                "resolve_model_ifc_bytes: original IFC lookup failed for model %s, stream %s on %s (%s) — "
                "falling back to synthetic export", model_id, stream_id, lookup_server_url, exc,
            )

    if ifc_bytes is None:
        model_row, elements, params = await asyncio.to_thread(_load_export_data, model_id, coord_unit)
        relationships = await asyncio.to_thread(_load_relationships_for_export, model_id)
        ifc_bytes = await run_cpu_bound(
            export_model, model_row, elements, params, coord_unit, None, None, relationships
        )

    return ifc_bytes, ifc_source


@router.get("/models/{model_id}/quantities")
def get_model_quantities(model_id: str, group_by: str = "ifc_class"):
    """
    5D quantity takeoff from the database — no IFC load required.
    Returns element counts + volume (m³) + area (m²) per group.
    group_by: 'ifc_class' (default), 'category', or 'storey'
    """
    from db.connection import get_conn, release_conn
    from db.query import get_quantity_takeoff as _qto
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qto(conn, model_id, group_by)
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/export/ifc")
async def start_export_ifc(model_id: str, coord_unit: str = "mm", include_schedule: bool = False):
    """
    Start an async IFC4X3 export job. Returns {job_id, status}.
    Poll GET /export/{job_id}/status, then download from GET /export/{job_id}/download.
    include_schedule=True also attaches any 4D tasks (bim_tasks/bim_task_elements)
    as IfcWorkSchedule/IfcTask/IfcRelAssignsToProcess.
    """
    from ifc.export import export_model
    from db.connection import get_conn, release_conn
    from db.schedule import get_tasks_for_export

    job_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        create_job(conn, job_id, "export", payload={
            "model_id": model_id, "coord_unit": coord_unit, "include_schedule": include_schedule,
        })
    finally:
        release_conn(conn)

    def _load_tasks(mid: str):
        conn3 = get_conn()
        try:
            return get_tasks_for_export(conn3, mid)
        finally:
            release_conn(conn3)

    async def _run():
        conn2 = get_conn()
        try:
            model_row, elements, params = await asyncio.to_thread(
                _load_export_data, model_id, coord_unit
            )
            relationships = await asyncio.to_thread(_load_relationships_for_export, model_id)
            tasks, task_elements = ([], {})
            if include_schedule:
                tasks, task_elements = await asyncio.to_thread(_load_tasks, model_id)
            model_name = model_row.get("branch_name") or model_row.get("commit_id", model_id)[:8]
            ifc_bytes = await run_cpu_bound(
                export_model, model_row, elements, params, coord_unit, tasks, task_elements, relationships
            )
            filename = f"{model_name}_{model_id[:8]}.ifc"
            temp_path = _export_temp_path(job_id)
            def _write_export_file():
                with open(temp_path, "wb") as f:
                    f.write(ifc_bytes)
            # Explicit `with` instead of the previous open(...).write(...)
            # one-liner, which relied on CPython's refcounting to close the
            # file promptly rather than guaranteeing it.
            await asyncio.to_thread(_write_export_file)
            update_job(conn2, job_id, status="complete", result={
                "filename": filename, "temp_path": temp_path,
            })
            logger.info("IFC export job %s complete: %d bytes", job_id, len(ifc_bytes))
        except Exception as exc:
            logger.error("IFC export job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                _prune_export_jobs(conn2)
            finally:
                release_conn(conn2)

    fire_and_forget(_run())
    return {"job_id": job_id, "status": "pending"}


def _job_status_response(job_id: str) -> dict:
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        job = get_job(conn, job_id)
    finally:
        release_conn(conn)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="Export job not found — it may have completed before a backend restart, or never existed",
        )
    return {"job_id": job_id, "status": job["status"], "error": job["error"]}


@router.get("/models/{model_id}/export/ifc/{job_id}/status")
def export_job_status(model_id: str, job_id: str):
    """Poll the status of a background IFC4X3 export job."""
    return _job_status_response(job_id)


@router.get("/models/{model_id}/export/ifcx/{job_id}/status")
def export_job_status_ifcx(model_id: str, job_id: str):
    """Poll the status of a background, EXPERIMENTAL IFC5 (.ifcx) export job."""
    return _job_status_response(job_id)


@router.post("/models/{model_id}/export/ifcx")
async def start_export_ifcx(model_id: str, coord_unit: str = "mm"):
    """
    Start an async, EXPERIMENTAL IFC5 (.ifcx) export job. IFC5 is an
    unratified alpha spec from buildingSMART — this covers only spatial
    hierarchy, IFC class, body mesh geometry, and flat properties (no
    materials, quantities, relationships, or 4D schedule; see
    /export/ifc for the mature IFC4X3 export that includes those).
    Returns {job_id, status}. Poll GET /export/ifcx/{job_id}/status, then
    download from GET /export/ifcx/{job_id}/download.
    """
    from ifc.export_ifcx import export_model_ifcx
    from db.connection import get_conn, release_conn

    job_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        create_job(conn, job_id, "export_ifcx", payload={
            "model_id": model_id, "coord_unit": coord_unit,
        })
    finally:
        release_conn(conn)

    async def _run():
        conn2 = get_conn()
        try:
            model_row, elements, params = await asyncio.to_thread(
                _load_export_data, model_id, coord_unit
            )
            model_name = model_row.get("branch_name") or model_row.get("commit_id", model_id)[:8]
            ifcx_bytes = await run_cpu_bound(
                export_model_ifcx, model_row, elements, params, coord_unit
            )
            filename = f"{model_name}_{model_id[:8]}.ifcx"
            temp_path = _export_temp_path_ifcx(job_id)
            def _write_export_file():
                with open(temp_path, "wb") as f:
                    f.write(ifcx_bytes)
            await asyncio.to_thread(_write_export_file)
            update_job(conn2, job_id, status="complete", result={
                "filename": filename, "temp_path": temp_path,
            })
            logger.info("IFC5 (.ifcx) export job %s complete: %d bytes", job_id, len(ifcx_bytes))
        except Exception as exc:
            logger.error("IFC5 (.ifcx) export job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                _prune_export_jobs(conn2, "export_ifcx")
            finally:
                release_conn(conn2)

    fire_and_forget(_run())
    return {"job_id": job_id, "status": "pending"}


class OriginalIfcRequest(BaseModel):
    token: str | None = None       # overrides env token if provided
    server_url: str | None = None  # overrides env server URL if provided


@router.post("/streams/{stream_id}/original-ifc")
async def get_original_ifc(stream_id: str, request: OriginalIfcRequest | None = None):
    """
    Proxy-download the original IFC file blob attached to a Speckle stream.

    Browsers can't call the Speckle server's /api/stream/{id}/blob/{id} REST
    endpoint directly due to CORS, so the frontend routes the download through
    this normalizer endpoint instead.
    """
    from speckle.fetch import find_original_ifc_blob, iter_original_ifc_blob

    token = request.token if request else None
    server_url = request.server_url if request else None

    blob = await asyncio.to_thread(find_original_ifc_blob, stream_id, token, server_url)
    if blob is None:
        raise HTTPException(status_code=404, detail="No original IFC file found for this stream")

    headers = {
        "Content-Disposition": _content_disposition(blob["filename"]),
    }
    if blob.get("file_size"):
        headers["Content-Length"] = str(blob["file_size"])

    return StreamingResponse(
        iter_original_ifc_blob(stream_id, blob),
        media_type="application/octet-stream",
        headers=headers,
    )


def _download_export_job(job_id: str, default_filename: str, media_type: str):
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        job = get_job(conn, job_id)
        if not job:
            raise HTTPException(
                status_code=404,
                detail="Export job not found — it may have completed before a backend restart, or never existed",
            )
        if job["status"] != "complete":
            raise HTTPException(status_code=409, detail=f"Export not ready: {job['status']}")

        temp_path = job["result"].get("temp_path")
        filename = job["result"].get("filename") or default_filename
        if not temp_path or not os.path.exists(temp_path):
            raise HTTPException(
                status_code=410,
                detail="Export artifact no longer available (likely lost in a backend restart) — please re-run the export",
            )
        file_size = os.path.getsize(temp_path)

        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM bim_jobs WHERE job_id = %s", (job_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        release_conn(conn)

    def _iter_file(path: str, chunk_size: int = 1024 * 1024):
        try:
            with open(path, "rb") as fh:
                while True:
                    chunk = fh.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    return StreamingResponse(
        _iter_file(temp_path),
        media_type=media_type,
        headers={
            "Content-Disposition": _content_disposition(filename),
            "Content-Length": str(file_size),
        },
    )


@router.get("/models/{model_id}/export/ifc/{job_id}/download")
def export_job_download(model_id: str, job_id: str):
    """Download the IFC4X3 file once the export job is complete. Cleans up the job after download."""
    return _download_export_job(job_id, f"export_{job_id[:8]}.ifc", "application/x-step")


@router.get("/models/{model_id}/export/ifcx/{job_id}/download")
def export_job_download_ifcx(model_id: str, job_id: str):
    """Download the EXPERIMENTAL IFC5 (.ifcx) file once the export job is
    complete. Cleans up the job after download. Media type is plain JSON —
    no IANA-registered .ifcx MIME type exists yet, and .ifcx *is* JSON."""
    return _download_export_job(job_id, f"export_{job_id[:8]}.ifcx", "application/json")
