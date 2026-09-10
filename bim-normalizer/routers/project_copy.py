import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dashboard_auth.dependencies import CurrentUser, require_login
from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget

router = APIRouter(tags=["project-copy"])
logger = logging.getLogger(__name__)


class ProjectCopyRequest(BaseModel):
    source_stream_id: str
    source_token: str
    source_server_url: str
    dest_server_url: str
    dest_token: str
    dest_project_name: str | None = None
    dest_workspace_id: str | None = None
    full_history: bool = False


@router.post("/projects/copy")
async def copy_project(request: ProjectCopyRequest, user: CurrentUser = Depends(require_login)):
    """
    Copy an entire Speckle project — every model, and either just its latest
    version or its full history — to a new project on a different Speckle
    server. Neither server needs to be one this app is already configured
    against: source_token/dest_token are used as-is, straight from the
    request. Gated on require_login only (not a project-role check like
    filter-publish) — the source project isn't necessarily one this app has
    ever ingested or has a role table entry for at all.

    Returns {job_id} — poll GET /projects/copy/{job_id}/status for the result.
    """
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        job_id = str(uuid.uuid4())
        create_job(conn, job_id, "project_copy", payload={
            "source_stream_id": request.source_stream_id,
            "source_server_url": request.source_server_url,
            "dest_server_url": request.dest_server_url,
        })
    finally:
        release_conn(conn)

    async def _run():
        from db.connection import get_conn as _get_conn, release_conn as _release_conn
        from speckle.publish import copy_project_to_server

        try:
            result = await asyncio.to_thread(
                copy_project_to_server,
                source_stream_id=request.source_stream_id,
                source_token=request.source_token,
                source_server_url=request.source_server_url,
                dest_server_url=request.dest_server_url,
                dest_token=request.dest_token,
                dest_project_name=request.dest_project_name,
                dest_workspace_id=request.dest_workspace_id,
                full_history=request.full_history,
            )
            conn2 = _get_conn()
            try:
                update_job(conn2, job_id, status="complete", result=result)
            finally:
                _release_conn(conn2)
        except Exception as exc:
            logger.error("project-copy job %s failed: %s", job_id, exc, exc_info=True)
            conn3 = _get_conn()
            try:
                update_job(conn3, job_id, status="failed", error=str(exc))
            finally:
                _release_conn(conn3)
        finally:
            conn4 = _get_conn()
            try:
                prune_jobs(conn4, "project_copy")
            finally:
                _release_conn(conn4)

    fire_and_forget(_run())
    logger.info("project-copy job %s started: %s@%s -> %s", job_id, request.source_stream_id,
                request.source_server_url, request.dest_server_url)
    return {"job_id": job_id, "status": "pending"}


@router.get("/projects/copy/{job_id}/status")
def copy_project_status(job_id: str):
    """Poll the status of a project-copy job."""
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
