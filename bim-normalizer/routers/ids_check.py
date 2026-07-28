import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

from job_registry import _is_uuid, fire_and_forget
from process_pool import run_cpu_bound
from db.jobs import create_job, update_job, get_job, prune_jobs
from routers.ifc_export import resolve_model_ifc_bytes

router = APIRouter(tags=["ids-check"])
logger = logging.getLogger(__name__)


@router.post("/models/{model_id}/ids-specs")
async def upload_ids_spec(model_id: str, file: UploadFile):
    """Upload and store an .ids file for this model. Rejects malformed IDS XML."""
    from ids_check import validate_ids_xml, InvalidIdsError
    from db.connection import get_conn, release_conn

    if not _is_uuid(model_id):
        raise HTTPException(status_code=400, detail=f"Invalid model id: {model_id!r}")

    raw = await file.read()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="IDS file must be UTF-8 encoded XML")

    try:
        await asyncio.to_thread(validate_ids_xml, content)
    except InvalidIdsError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid IDS file: {exc}")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Model {model_id} not found")
            cur.execute(
                """
                INSERT INTO bim_ids_specs (model_id, filename, content)
                VALUES (%s, %s, %s)
                RETURNING spec_id, filename, uploaded_at
                """,
                (model_id, file.filename or "spec.ids", content),
            )
            spec_id, filename, uploaded_at = cur.fetchone()
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except Exception as exc:
        conn.rollback()
        logger.error("IDS spec upload failed for model %s: %s", model_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")
    finally:
        release_conn(conn)
    return {"spec_id": str(spec_id), "filename": filename, "uploaded_at": uploaded_at.isoformat()}


@router.get("/models/{model_id}/ids-specs")
def list_ids_specs(model_id: str):
    """List previously uploaded .ids files for this model."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spec_id, filename, uploaded_at FROM bim_ids_specs WHERE model_id = %s ORDER BY uploaded_at DESC",
                (model_id,),
            )
            rows = cur.fetchall()
    finally:
        release_conn(conn)
    return [
        {"spec_id": str(r[0]), "filename": r[1], "uploaded_at": r[2].isoformat()}
        for r in rows
    ]


@router.get("/models/{model_id}/ids-specs/{spec_id}")
def get_ids_spec(model_id: str, spec_id: str):
    """Fetch one spec's raw IDS XML — used by the visual editor to load an
    existing spec back onto the canvas."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spec_id, filename, content, uploaded_at FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, spec_id),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)
    if not row:
        raise HTTPException(status_code=404, detail="IDS spec not found")
    return {"spec_id": str(row[0]), "filename": row[1], "content": row[2], "uploaded_at": row[3].isoformat()}


@router.delete("/models/{model_id}/ids-specs/{spec_id}", status_code=204)
def delete_ids_spec(model_id: str, spec_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, spec_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


class IdsCheckRequest(BaseModel):
    spec_id: str
    coord_unit: str = "mm"
    server_url: str | None = None  # overrides the model's stored ingest server, e.g. for a fresh token
    token: str | None = None       # overrides env token if provided


@router.post("/models/{model_id}/ids-check")
async def start_ids_check(model_id: str, body: IdsCheckRequest):
    """
    Start an async IDS check job: export the model to IFC, validate it
    against the stored spec, and keep the report in memory.
    Poll GET /ids-check/{job_id}/status for the result.
    """
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT content FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, body.spec_id),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)
    if not row:
        raise HTTPException(status_code=404, detail="IDS spec not found")
    ids_content = row[0]

    job_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        create_job(conn, job_id, "ids_check", payload={"model_id": model_id, "spec_id": body.spec_id})
    finally:
        release_conn(conn)

    async def _run():
        from db.connection import get_conn as _get_conn, release_conn as _release_conn

        conn2 = _get_conn()
        try:
            from ids_check import run_ids_check

            # Prefer the real IFC file the source application (Revit/Tekla/IFC
            # connector) actually produced, when the Speckle stream has one
            # attached — IDS should validate the true exporter output, not
            # bim-normalizer's reconstruction (heuristic IFC-class assignment,
            # estimated storeys, mesh/bbox-only geometry, regenerated GUIDs).
            ifc_bytes, ifc_source = await resolve_model_ifc_bytes(
                model_id, body.token, body.server_url, body.coord_unit
            )

            logger.info("IDS check job %s: validating against %s (%d bytes)", job_id, ifc_source, len(ifc_bytes))
            result = await run_cpu_bound(
                run_ids_check, ifc_bytes, ids_content, ifc_source == "synthetic_export",
            )
            update_job(conn2, job_id, status="complete", result={"report": result, "ifc_source": ifc_source})
            logger.info("IDS check job %s complete: status=%s", job_id, result.get("status"))
        except Exception as exc:
            logger.error("IDS check job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                prune_jobs(conn2, "ids_check")
            finally:
                _release_conn(conn2)

    fire_and_forget(_run())
    return {"job_id": job_id, "status": "pending"}


@router.get("/models/{model_id}/ids-check/{job_id}/status")
def ids_check_status(model_id: str, job_id: str):
    """Poll an IDS check job. Once status == 'complete', `result` holds the report.
    `ifc_source` indicates whether the check ran against the model's true
    original IFC file ("original_ifc") or bim-normalizer's reconstruction
    ("synthetic_export", used when no original IFC blob is attached)."""
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        job = get_job(conn, job_id)
    finally:
        release_conn(conn)
    if not job:
        raise HTTPException(
            status_code=404,
            detail="IDS check job not found — it may have completed before a backend restart, or never existed",
        )
    result = job["result"] or {}
    return {
        "job_id": job_id,
        "status": job["status"],
        "error": job["error"],
        "result": result.get("report") if job["status"] == "complete" else None,
        "ifc_source": result.get("ifc_source"),
    }
