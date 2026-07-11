import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from job_registry import _is_uuid
from db.jobs import create_job, update_job, get_job, find_running_job, prune_jobs

router = APIRouter(tags=["ingest"])
logger = logging.getLogger(__name__)


class IngestRequest(BaseModel):
    stream_id: str
    commit_id: str
    token: str | None = None       # overrides env token if provided
    server_url: str | None = None  # overrides env server URL if provided
    force: bool = False            # bypass the "already ingested" fast path and re-run


@router.post("/ingest")
async def ingest(request: IngestRequest):
    from pipeline.normalize import ingest_commit
    from db.connection import get_conn, release_conn

    # Fast path: commit already ingested — return immediately without re-processing
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id::text, COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.stream_id = %s AND m.commit_id = %s
                GROUP BY m.model_id
            """, (request.stream_id, request.commit_id))
            row = cur.fetchone()

        if row and row[1] == 0:
            # Orphaned model row from a prior ingest that died after upsert_model
            # but before any elements were written. Clean it up now rather than
            # leaving a phantom empty model around until a retry happens to come in.
            logger.info(
                "Found orphaned model row %s for %s/%s (0 elements) — deleting before re-ingest",
                row[0], request.stream_id, request.commit_id,
            )
            with conn.cursor() as cur:
                cur.execute("DELETE FROM bim_models WHERE model_id = %s", (row[0],))
            conn.commit()
            row = None

        if row and row[1] > 0 and not request.force:
            logger.info("Commit %s already ingested (%d elements) — fast return", request.commit_id, row[1])
            return {"model_id": row[0], "status": "complete", "element_count": int(row[1])}

        # Deduplicate: reuse an existing running job for the same commit
        running_job_id = find_running_job(
            conn, "ingest", stream_id=request.stream_id, commit_id=request.commit_id,
        )
        if running_job_id:
            return {"job_id": running_job_id, "status": "pending"}

        # New ingest — start as a background asyncio task so the HTTP call returns immediately
        job_id = str(uuid.uuid4())
        create_job(conn, job_id, "ingest", payload={
            "stream_id": request.stream_id, "commit_id": request.commit_id,
        })
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)

    async def _run():
        from db.connection import get_conn as _get_conn, release_conn as _release_conn

        try:
            result = await asyncio.to_thread(
                ingest_commit,
                stream_id=request.stream_id,
                commit_id=request.commit_id,
                token=request.token,
                server_url=request.server_url,
            )
            job_conn = _get_conn()
            try:
                update_job(job_conn, job_id, status="complete", result={
                    "model_id": result["model_id"],
                    "element_count": result["element_count"],
                    "skipped_count": result.get("skipped_count"),
                    "skip_geo_count": result.get("skip_geo_count"),
                    "skip_param_count": result.get("skip_param_count"),
                    "embedded_count": result.get("embedded_count"),
                    "skip_embed_count": result.get("skip_embed_count"),
                })
            finally:
                _release_conn(job_conn)
        except Exception as exc:
            logger.error("Background ingest error (job %s): %s", job_id, exc, exc_info=True)
            job_conn = _get_conn()
            try:
                update_job(job_conn, job_id, status="failed", error=str(exc))
            finally:
                _release_conn(job_conn)
        finally:
            prune_conn = _get_conn()
            try:
                prune_jobs(prune_conn, "ingest")
            finally:
                _release_conn(prune_conn)

    asyncio.create_task(_run())
    logger.info("Ingest job %s started for commit %s", job_id, request.commit_id)
    return {"job_id": job_id, "status": "pending"}


@router.get("/ingest/status/{job_id}")
def ingest_status(job_id: str):
    """Poll the status of a background ingest job."""
    from db.connection import get_conn, release_conn

    if not _is_uuid(job_id):
        raise HTTPException(status_code=400, detail="Malformed job id")

    conn = get_conn()
    try:
        job = get_job(conn, job_id)
    finally:
        release_conn(conn)

    if not job:
        raise HTTPException(
            status_code=404,
            detail="Job not found — it may have completed before a backend restart, or never existed",
        )
    response = {"job_id": job["job_id"], "status": job["status"], "error": job["error"]}
    response.update(job["result"])
    return response
