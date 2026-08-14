import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel

from dashboard_auth.dependencies import ANY_PROJECT_ROLE, CurrentUser, require_login, require_project_role, require_role

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)

_VALID_MODEL_STATUSES = ("WIP", "Shared", "Published", "Archived")

# Shared across every upload_ifc_status poll below instead of opening a fresh
# TLS connection to the Speckle server every ~3s — that per-poll connection
# churn made transient slowness on Speckle's own end (its fileimport-service
# saturating the host's resources while converting a large IFC) much worse:
# a failed poll cost the full timeout instead of failing fast and letting the
# frontend's retry loop try again promptly. A `fileUploads` GraphQL lookup is
# a cheap query — it should never legitimately need more than a few seconds.
_status_http_client = httpx.AsyncClient(timeout=8)

# Speckle server's own FileUpload.convertedStatus values (packages/server's
# FileuploadConvertedStatus enum) — Speckle assigns these, we don't control
# or invent them. convertedCommitId being non-null is treated as the
# authoritative "done" signal below regardless of the exact code, since it's
# the one thing that can't be misread.
_UPLOAD_STATUS_MAP = {0: "queued", 1: "processing", 2: "success", 3: "error"}


@router.get("/models")
def list_models():
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id, m.stream_id, m.commit_id, m.branch_name,
                       m.source, m.author, m.message, m.ingested_at, m.ingest_status,
                       COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                GROUP BY m.model_id
                ORDER BY m.ingested_at DESC
            """)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@router.get("/models/by-stream/{stream_id}")
def list_models_for_stream(stream_id: str):
    """Every ingested bim_models row for one Speckle project, newest commit
    per branch first. Used to scope the federated-view / multi-model
    clash-compare pickers to the current project, unlike /models above
    which lists every ingested model globally."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id, m.stream_id, m.commit_id, m.branch_name,
                       m.source, m.author, m.message, m.ingested_at, m.ingest_status,
                       COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.stream_id = %s
                GROUP BY m.model_id
                ORDER BY m.branch_name, m.ingested_at DESC
            """, (stream_id,))
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@router.get("/models/{model_id}")
def get_model(model_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.*, COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.model_id = %s
                GROUP BY m.model_id
            """, (model_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            cols = [d[0] for d in cur.description]
        return dict(zip(cols, row))
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}")
def delete_model(model_id: str, user: CurrentUser = Depends(require_login)):
    """
    Delete a model and all its associated elements, geometry, and parameters.
    After deletion the next /ingest for the same commit will re-classify from scratch.

    stream_id isn't in this route's path (only model_id is), so the project
    role check happens here in the body once the model's own stream_id is
    known, rather than via a static Depends(require_role(...)) — same
    pattern require_project_role's own docstring describes.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT stream_id FROM bim_models WHERE model_id = %s", (model_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            require_project_role(conn, row[0], user, ANY_PROJECT_ROLE)
            # Cascade deletes handle elements → geometry + parameters via FK
            cur.execute("DELETE FROM bim_models WHERE model_id = %s", (model_id,))
        conn.commit()
        logger.info("Deleted model %s", model_id)
        return {"deleted": model_id}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.get("/models/trend/{stream_id}")
def get_model_trend(stream_id: str):
    """
    Version history trend for a stream.
    Returns [{model_id, commit_id, branch_name, ingested_at, source, message,
              total_elements, total_volume_m3, total_area_m2,
              by_category: {cat: count}, volume_by_category: {cat: volume_m3}}]
    ordered oldest → newest.  Used to plot element-count/volume evolution over time.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_trend as _trend
    conn = get_conn()
    try:
        return _trend(conn, stream_id)
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/model-status")
def get_model_statuses(stream_id: str, user: CurrentUser = Depends(require_login)):
    """{branch_name: status} for every branch that has an explicitly-set
    status. A branch missing from the result defaults to 'WIP' on the
    frontend — no row is written until a user actually changes it."""
    from db.connection import get_conn, release_conn
    from db.model_status import list_statuses
    conn = get_conn()
    try:
        return list_statuses(conn, stream_id)
    finally:
        release_conn(conn)


class ModelStatusRequest(BaseModel):
    branch_name: str
    status: str


@router.post("/projects/{stream_id}/model-status")
def set_model_status(stream_id: str, body: ModelStatusRequest, user: CurrentUser = Depends(require_login)):
    """ISO 19650 gating, same shape as routers/documents.py's move_document —
    reuses bim_document_roles (the "author/reviewer/approver" CDE roles
    apply to any information container moving through this workflow, not
    just files) since models had no gating at all before this: WIP->Shared
    needs any role, Shared->Published and ->Archived need approver, and any
    non-adjacent/backward move is treated as the strictest case (approver)."""
    if body.status not in _VALID_MODEL_STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of: {', '.join(_VALID_MODEL_STATUSES)}")
    from db.connection import get_conn, release_conn
    from db.model_status import list_statuses, set_status
    conn = get_conn()
    try:
        current = list_statuses(conn, stream_id).get(body.branch_name, "WIP")
        if body.status == current:
            return {"stream_id": stream_id, "branch_name": body.branch_name, "status": current}
        if body.status == "Shared" and current == "WIP":
            require_project_role(conn, stream_id, user, ANY_PROJECT_ROLE)
        elif body.status == "Published" and current == "Shared":
            require_project_role(conn, stream_id, user, ("approver",))
        elif body.status == "Archived" and current == "Published":
            require_project_role(conn, stream_id, user, ("approver",))
        else:
            require_project_role(conn, stream_id, user, ("approver",))
        return set_status(conn, stream_id, body.branch_name, body.status)
    finally:
        release_conn(conn)


class ModelDeleteCleanupRequest(BaseModel):
    branch_name: str


@router.post("/projects/{stream_id}/models/delete-cleanup")
def delete_model_cleanup(stream_id: str, body: ModelDeleteCleanupRequest, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    """
    Local-side cleanup after the frontend has already deleted the branch on
    Speckle itself via GraphQL (branchDelete) — Speckle write credentials
    belong to whichever server the user's session is pointed at, so that
    mutation happens client-side (SpeckleModelsList.jsx), not here.

    Cleans up everything this backend owns for that branch: any Nextcloud
    documents explicitly linked to one of its elements (the link-element
    feature), the locally-ingested bim_models copy for every commit on the
    branch (cascades to elements/geometry/parameters, same as the existing
    webhook-driven db.purge.purge_speckle_models path), and the
    bim_model_status row.
    """
    from db.connection import get_conn, release_conn
    from db.purge import purge_speckle_models
    from db.model_status import delete_status
    from db.documents import soft_delete_document, record_event
    from nextcloud.client import delete as nc_delete

    conn = get_conn()
    deleted_doc_ids: list[str] = []
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT d.doc_id, d.nc_path
                FROM bim_documents d
                JOIN bim_elements e ON e.speckle_id = d.linked_element
                JOIN bim_models m ON m.model_id = e.model_id
                WHERE m.stream_id = %s AND m.branch_name = %s AND d.deleted_at IS NULL
                """,
                (stream_id, body.branch_name),
            )
            linked_docs = cur.fetchall()

        for doc_id, nc_path in linked_docs:
            try:
                nc_delete(nc_path)
            except Exception as exc:
                logger.warning(
                    "Nextcloud delete failed for doc %s during model cleanup (soft-deleting locally anyway): %s",
                    doc_id, exc,
                )
            soft_delete_document(conn, str(doc_id))
            record_event(conn, str(doc_id), "deleted", actor=f"{user.name} (model deletion cleanup)", actor_guid=user.guid)
            deleted_doc_ids.append(str(doc_id))

        deleted_models = purge_speckle_models(stream_id, branch_name=body.branch_name)
        delete_status(conn, stream_id, body.branch_name)

        return {"deleted_local_models": deleted_models, "deleted_documents": deleted_doc_ids}
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/models/upload-ifc")
async def upload_ifc_model(
    stream_id: str, file: UploadFile, branch_name: str = "uploads",
    token: str | None = None, server_url: str | None = None,
    user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE)),
):
    """
    Upload a raw .ifc file directly into this Speckle project as a new model,
    without needing a desktop connector. Proxies the file to Speckle server's
    own native file-import REST endpoint (confirmed present on this server —
    POST /api/file/autodetect/{streamId}/{branchName}, the same route
    Speckle's own web app uses for drag-and-drop IFC upload) — Speckle's
    fileimport-service parses the IFC and creates the commit server-side;
    this backend does no IFC-to-Speckle conversion itself.

    token/server_url follow the same override convention as /ingest, so this
    works against whichever Speckle server the frontend's active session is
    pointed at, not just the one in this backend's own .env.

    Returns {upload_id, branch_name}. Poll
    GET .../models/upload-ifc/{upload_id}/status for the resulting commit_id,
    then call the normal /ingest with it — same as any other new commit.
    """
    import asyncio
    import httpx
    from config import settings
    from speckle.publish import _ensure_branch

    if not file.filename or not file.filename.lower().endswith(".ifc"):
        raise HTTPException(status_code=422, detail="Only .ifc files are accepted")

    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    content = await file.read()

    # Speckle's file-import endpoint 404s with BRANCH_NOT_FOUND if the target
    # branch doesn't already exist — unlike commitCreate, it won't create one.
    try:
        await asyncio.to_thread(
            _ensure_branch, srv, tok, stream_id, branch_name,
            f'Created for uploaded IFC file "{file.filename}"',
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not create/verify branch {branch_name!r} on Speckle: {exc}")

    async with httpx.AsyncClient(timeout=180) as client:
        try:
            resp = await client.post(
                f"{srv}/api/file/autodetect/{stream_id}/{branch_name}",
                headers={"Authorization": f"Bearer {tok}"},
                files={"files": (file.filename, content, "application/octet-stream")},
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Could not reach Speckle server: {exc}")

    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Speckle upload failed ({resp.status_code}): {resp.text[:300]}")

    try:
        body = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"Unexpected (non-JSON) response from Speckle: {resp.text[:300]}")

    # Server response shape has varied across Speckle versions — handle both
    # {"uploadResults": [{"id": ...}, ...]} and a bare list defensively.
    results = body.get("uploadResults") if isinstance(body, dict) else body
    upload_id = None
    if results:
        upload_id = results[0].get("id") or results[0].get("blobId")
    if not upload_id:
        raise HTTPException(status_code=502, detail=f"Speckle did not return an upload id: {body}")

    return {"upload_id": upload_id, "branch_name": branch_name}


@router.get("/projects/{stream_id}/models/upload-ifc/{upload_id}/status")
async def upload_ifc_status(stream_id: str, upload_id: str, token: str | None = None, server_url: str | None = None):
    """Poll Speckle's own Stream.fileUploads for this upload's conversion status."""
    from config import settings

    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")

    try:
        resp = await _status_http_client.post(
            f"{srv}/graphql",
            json={
                "query": """
                    query($id: String!) {
                        stream(id: $id) {
                            fileUploads {
                                id
                                fileName
                                uploadComplete
                                convertedStatus
                                convertedMessage
                                convertedCommitId
                            }
                        }
                    }
                """,
                "variables": {"id": stream_id},
            },
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
        )
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        # Speckle's own API being briefly unresponsive (e.g. fileimport-service
        # saturating the host while converting a large IFC) shouldn't surface
        # as an opaque 500 — 502 + a clear message lets the frontend's poll
        # loop tell "still working, try again" apart from a real failure.
        raise HTTPException(status_code=502, detail=f"Speckle status check failed: {exc}")
    finally:
        # _status_http_client is shared across polls from potentially different
        # users/tokens/Speckle servers (see its definition above) purely to
        # reuse the connection pool — never let it accumulate Set-Cookie state
        # from one identity into the next request. This is the same class of
        # cross-identity leakage a shared requests.Session caused for Nextcloud
        # (see nextcloud/client.py), fixed by making that policy explicit there;
        # clearing the jar here is the httpx equivalent for this client.
        _status_http_client.cookies.clear()
    body = resp.json()
    if "errors" in body:
        raise HTTPException(status_code=502, detail=body["errors"][0]["message"])

    uploads = ((body.get("data") or {}).get("stream") or {}).get("fileUploads") or []
    match = next((u for u in uploads if u.get("id") == upload_id), None)
    if not match:
        raise HTTPException(status_code=404, detail="Upload not found yet on Speckle — try again shortly")

    return {
        "upload_id": upload_id,
        "status": _UPLOAD_STATUS_MAP.get(match.get("convertedStatus"), "unknown"),
        "message": match.get("convertedMessage"),
        "commit_id": match.get("convertedCommitId"),
    }
