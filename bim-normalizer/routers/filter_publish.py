import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget

router = APIRouter(tags=["filter-publish"])
logger = logging.getLogger(__name__)


class FilterPublishRequest(BaseModel):
    speckle_ids: list[str] | None = None  # explicit IDs; if set, filters below are ignored
    category: str | None = None
    ifc_class: str | None = None
    storey: str | None = None
    target_branch: str = "filtered/selection"
    message: str = ""
    token: str | None = None
    server_url: str | None = None


@router.post("/models/{model_id}/filter-publish")
async def filter_publish(model_id: str, request: FilterPublishRequest):
    """
    Filter elements from a normalized model and publish the selection as a
    new commit on the same Speckle server.

    Filtering: provide any combination of category / ifc_class / storey for
    DB-based selection, OR an explicit speckle_ids list.  If speckle_ids is
    given the other filters are ignored.

    Returns {job_id} — poll GET /filter-publish/{job_id}/status for the result.
    """
    from db.connection import get_conn, release_conn
    from speckle.publish import filter_and_publish

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id, commit_id FROM bim_models WHERE model_id = %s",
                (model_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            stream_id, commit_id = row[0], row[1]

        job_id = str(uuid.uuid4())
        create_job(conn, job_id, "filter_publish", payload={"model_id": model_id})
    finally:
        release_conn(conn)

    async def _run():
        from db.connection import get_conn as _get_conn, release_conn as _release_conn

        # Resolve speckle_ids
        speckle_ids: set[str] = set()
        if request.speckle_ids:
            speckle_ids = {s for s in request.speckle_ids if s}
        else:
            conn2 = _get_conn()
            try:
                where = ["model_id = %s"]
                params: list = [model_id]
                if request.category:
                    where.append("category ILIKE %s")
                    params.append(f"%{request.category}%")
                if request.ifc_class:
                    where.append("ifc_class = %s")
                    params.append(request.ifc_class)
                if request.storey:
                    where.append("storey ILIKE %s")
                    params.append(f"%{request.storey}%")
                with conn2.cursor() as cur:
                    cur.execute(
                        f"SELECT speckle_id FROM bim_elements WHERE {' AND '.join(where)}",
                        params,
                    )
                    speckle_ids = {r[0] for r in cur.fetchall() if r[0]}
            finally:
                _release_conn(conn2)

        if not speckle_ids:
            conn3 = _get_conn()
            try:
                update_job(conn3, job_id, status="failed", error="No elements matched the filter criteria")
            finally:
                _release_conn(conn3)
            return

        conn4 = _get_conn()
        try:
            result = await asyncio.to_thread(
                filter_and_publish,
                stream_id=stream_id,
                commit_id=commit_id,
                speckle_ids=speckle_ids,
                target_branch=request.target_branch,
                message=request.message,
                token=request.token,
                server_url=request.server_url,
            )
            update_job(conn4, job_id, status="complete", result=result)
        except Exception as exc:
            logger.error("filter-publish job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn4, job_id, status="failed", error=str(exc))
        finally:
            try:
                prune_jobs(conn4, "filter_publish")
            finally:
                _release_conn(conn4)

    fire_and_forget(_run())
    logger.info("filter-publish job %s started for model %s", job_id, model_id)
    return {"job_id": job_id, "status": "pending"}


@router.get("/filter-publish/{job_id}/status")
def filter_publish_status(job_id: str):
    """Poll the status of a filter-publish job."""
    from db.connection import get_conn, release_conn

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
    return {"status": job["status"], "result": job["result"] or None, "error": job["error"]}
