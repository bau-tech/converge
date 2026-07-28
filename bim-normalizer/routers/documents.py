"""
Document management routes (Nextcloud-backed) — stream-scoped like
bcf/topics.py's /projects/{stream_id}/... convention, not /models/... (a
document must survive re-ingestion, so it can't be pinned to one commit's
model_id the way BCF topics currently are).

ISO 19650 state-transition gating + RBAC: every write endpoint requires a
real dashboard login (dashboard_auth, session-cookie backed by bcf_users —
the same accounts bcf-server's /admin panel and external BCF-client auth
use). Actor attribution (approved_by/reviewed_by/verified_by, event actor)
is always derived from the authenticated session now, never client-supplied.
Per-project roles (author/reviewer/approver, bim_document_roles) gate the
three forward CDE transitions — WIP->Shared needs `reviewed` (review),
Shared->Published needs `approved` (authorisation), ->Archived needs
`verified` (verification) — plus any backward/demotion move, which requires
approver. Roles are assigned via bcf-server's admin panel (bcf/admin.py).
"""
import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from dashboard_auth.dependencies import ANY_PROJECT_ROLE, CurrentUser, require_login, require_project_role, require_role
from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget
from nextcloud.groupfolders import STATUS_FOLDERS as _STATUS_FOLDERS

router = APIRouter(tags=["documents"])
logger = logging.getLogger(__name__)

_VALID_STATUSES = tuple(_STATUS_FOLDERS.keys())
_VALID_DOC_TYPES = ("document", "drawing")


def _model_belongs_to_stream(conn, stream_id: str, model_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM bim_models WHERE model_id = %s AND stream_id = %s",
            (model_id, stream_id),
        )
        return cur.fetchone() is not None


def _group_folder(stream_id: str) -> str:
    from nextcloud.groupfolders import group_folder_mountpoint
    return group_folder_mountpoint(stream_id)


def _latest_model_id(conn, stream_id: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT model_id FROM bim_models WHERE stream_id = %s ORDER BY ingested_at DESC LIMIT 1",
            (stream_id,),
        )
        row = cur.fetchone()
    return str(row[0]) if row else None


def _require_doc(conn, doc_id: str) -> dict:
    from db.documents import get_document
    doc = get_document(conn, doc_id)
    if doc is None or doc["deleted_at"] is not None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.get("/projects/{stream_id}/my-roles")
def my_roles(stream_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.roles import get_user_roles
    conn = get_conn()
    try:
        return {"roles": sorted(get_user_roles(conn, user.guid, stream_id))}
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents")
def list_documents(stream_id: str, status: str | None = None, linked_element: str | None = None, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.documents import list_documents as _list
    conn = get_conn()
    try:
        return _list(conn, stream_id, status=status, linked_element=linked_element)
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/linked-positions")
def linked_positions(stream_id: str, model_id: str, user: CurrentUser = Depends(require_login)):
    """speckle_id + geometry centroid for elements with a linked document in
    the given model — feeds the viewer's document-pin overlay without the
    frontend having to pull full document rows per element. Must stay
    registered before GET /documents/{doc_id} below, or that route's path
    param would swallow "linked-positions" as a doc_id."""
    from db.connection import get_conn, release_conn
    from db.documents import list_linked_positions
    conn = get_conn()
    try:
        return list_linked_positions(conn, stream_id, model_id)
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/{doc_id}")
def get_document_detail(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.documents import list_events
    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        doc["events"] = list_events(conn, doc_id)
        return doc
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/{doc_id}/download")
def download_document(stream_id: str, doc_id: str, inline: bool = False, user: CurrentUser = Depends(require_login)):
    """inline=true renders in place (e.g. PDF in an <iframe>) instead of
    forcing a download — used by DocumentPreview.jsx's PDF viewer only."""
    from db.connection import get_conn, release_conn
    from nextcloud.client import download_bytes
    from job_registry import _content_disposition

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
    finally:
        release_conn(conn)

    content = download_bytes(doc["nc_path"])
    disposition = "inline" if inline else "attachment"
    return Response(
        content=content,
        media_type=doc["mime_type"] or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(doc["filename"], disposition)},
    )


@router.get("/projects/{stream_id}/documents/{doc_id}/preview.dxf")
def preview_dwg_as_dxf(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_login)):
    """On-the-fly .dwg -> .dxf conversion (dwg_convert.py, LibreDWG's
    dwg2dxf) so the frontend's existing DxfCanvas.jsx can render it — no
    free/open library renders DWG directly. Converted fresh on every
    request rather than cached, matching /thumbnail's proxy-on-demand style."""
    from db.connection import get_conn, release_conn
    from dwg_convert import convert_dwg_to_dxf, DwgConversionError
    from nextcloud.client import download_bytes

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
    finally:
        release_conn(conn)

    if not doc["filename"].lower().endswith(".dwg"):
        raise HTTPException(status_code=400, detail="Not a .dwg document")

    dwg_bytes = download_bytes(doc["nc_path"])
    try:
        dxf_bytes = convert_dwg_to_dxf(dwg_bytes)
    except DwgConversionError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=dxf_bytes, media_type="text/plain")


@router.get("/projects/{stream_id}/documents/{doc_id}/thumbnail")
def thumbnail_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_login)):
    """Proxies Nextcloud's preview API — the browser never sees Nextcloud
    credentials. Nextcloud has no CAD preview provider at all, so .dxf/.dwg
    specifically fall back to our own rendered thumbnail (dxf_thumbnail.py)
    instead of the generic icon every other unpreviewable format gets. .pdf
    gets the same treatment via pdf_thumbnail.py (pdftoppm) — lightweight,
    unlike DOCX/XLSX which would need a full LibreOffice pipeline (not
    implemented, deliberately deprioritized)."""
    import requests
    from config import settings
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
    finally:
        release_conn(conn)

    from nextcloud.client import _auth
    resp = requests.get(
        f"{settings.NEXTCLOUD_URL}/index.php/core/preview",
        params={"fileId": doc["nc_fileid"], "x": 256, "y": 256, "a": "1"},
        auth=_auth(), timeout=30,
    )
    if resp.status_code == 200:
        return Response(content=resp.content, media_type=resp.headers.get("Content-Type", "image/png"))

    filename = doc["filename"].lower()
    if filename.endswith(".dxf") or filename.endswith(".dwg"):
        from nextcloud.client import download_bytes
        from dxf_thumbnail import render_dxf_thumbnail, DxfThumbnailError

        raw = download_bytes(doc["nc_path"])
        if filename.endswith(".dwg"):
            from dwg_convert import convert_dwg_to_dxf, DwgConversionError
            try:
                raw = convert_dwg_to_dxf(raw)
            except DwgConversionError as exc:
                raise HTTPException(status_code=404, detail=f"No preview available: {exc}")
        try:
            png = render_dxf_thumbnail(raw)
        except DxfThumbnailError as exc:
            raise HTTPException(status_code=404, detail=f"No preview available: {exc}")
        return Response(content=png, media_type="image/png")

    if filename.endswith(".pdf"):
        from nextcloud.client import download_bytes
        from pdf_thumbnail import render_pdf_thumbnail, PdfThumbnailError

        raw = download_bytes(doc["nc_path"])
        try:
            png = render_pdf_thumbnail(raw)
        except PdfThumbnailError as exc:
            raise HTTPException(status_code=404, detail=f"No preview available: {exc}")
        return Response(content=png, media_type="image/png")

    raise HTTPException(status_code=404, detail="No preview available")


@router.post("/projects/{stream_id}/documents/upload")
async def upload_document(
    stream_id: str, file: UploadFile,
    doc_type: str = Form("document"),
    model_id: str | None = Form(None),
    user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE)),
):
    """Always lands in 01_WIP — new documents must go through the approval
    workflow before reaching Published, same as everything else.

    doc_type='drawing' requires an explicit model_id — deliberately not
    falling back to _latest_model_id() the way generic documents do below,
    since a drawing's model link is meant to be a deliberate user choice,
    not a best-effort guess."""
    from db.connection import get_conn, release_conn
    from db.documents import upsert_document, record_event
    from nextcloud.client import upload_bytes
    from nextcloud.provisioning import ensure_project_group

    if doc_type not in _VALID_DOC_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid doc_type, must be one of {_VALID_DOC_TYPES}")

    content = await file.read()
    filename = file.filename or "document"
    group_folder = _group_folder(stream_id)

    # Short-lived connection just for validation/model resolution — released
    # before the (potentially slow) Nextcloud upload, same as the rest of
    # this function never holding a connection across Nextcloud I/O.
    conn = get_conn()
    try:
        if doc_type == "drawing":
            if not model_id:
                raise HTTPException(status_code=400, detail="model_id is required for drawings")
            if not _model_belongs_to_stream(conn, stream_id, model_id):
                raise HTTPException(status_code=400, detail="model_id does not belong to this project")
        else:
            model_id = _latest_model_id(conn, stream_id)
    finally:
        release_conn(conn)

    try:
        ensure_project_group(stream_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud provisioning failed: {exc}")

    try:
        meta = upload_bytes(f"{group_folder}/{_STATUS_FOLDERS['WIP']}/{filename}", content, overwrite=False)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud upload failed: {exc}")

    conn = get_conn()
    try:
        doc = upsert_document(
            conn, stream_id=stream_id, model_id=model_id,
            nc_fileid=meta["fileid"], nc_path=meta["path"], nc_group_folder=group_folder,
            filename=meta["name"], mime_type=meta.get("mime_type"), size_bytes=meta.get("size"),
            etag=meta.get("etag"), status="WIP", doc_type=doc_type,
        )
        record_event(conn, doc["doc_id"], "created", to_value="WIP", actor=user.name, actor_guid=user.guid)
    finally:
        release_conn(conn)
    return doc


class MoveRequest(BaseModel):
    status: str


@router.post("/projects/{stream_id}/documents/{doc_id}/move")
def move_document(stream_id: str, doc_id: str, body: MoveRequest, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.documents import set_status, record_event
    from nextcloud.client import move as nc_move

    if body.status not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of: {', '.join(_VALID_STATUSES)}")

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        if body.status == doc["status"]:
            return doc

        # Forward transitions need every gate flag for each stage being
        # passed through on the way to the target status — not just the
        # one immediately adjacent to the current status — otherwise a
        # WIP -> Published (or -> Archived) request would skip the
        # intermediate reviewed/approved checks entirely. Any other move
        # (backward/demotion) reverses a formal review/authorisation/
        # verification decision, so it's treated like the strictest case
        # and requires approver regardless of direction.
        statuses = list(_VALID_STATUSES)
        old_idx = statuses.index(doc["status"])
        new_idx = statuses.index(body.status)

        if new_idx > old_idx:
            if new_idx >= statuses.index("Shared") and not doc["reviewed"]:
                raise HTTPException(status_code=409, detail="Document must be reviewed before moving to Shared or beyond")
            if new_idx >= statuses.index("Published") and not doc["approved"]:
                raise HTTPException(status_code=409, detail="Document must be approved (authorised) before it can be Published or beyond")
            if new_idx >= statuses.index("Archived") and not doc["verified"]:
                raise HTTPException(status_code=409, detail="Document must be verified before it can be Archived")
            # Reaching Published or Archived requires approver even when
            # jumping there directly; a move that only reaches Shared needs
            # any project role, matching the single-step case above.
            if new_idx >= statuses.index("Published"):
                require_project_role(conn, stream_id, user, ("approver",))
            else:
                require_project_role(conn, stream_id, user, ANY_PROJECT_ROLE)
        else:
            require_project_role(conn, stream_id, user, ("approver",))

        group_folder = doc["nc_group_folder"]
        old_folder = _STATUS_FOLDERS[doc["status"]]
        new_folder = _STATUS_FOLDERS[body.status]
        new_path = f"{group_folder}/{new_folder}/{doc['filename']}"
        try:
            nc_move(f"{group_folder}/{old_folder}/{doc['filename']}", new_path)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Nextcloud move failed: {exc}")

        updated = set_status(conn, doc_id, body.status, new_path)
        record_event(conn, doc_id, "moved", from_value=doc["status"], to_value=body.status, actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/documents/{doc_id}/review")
def review_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("reviewer", "approver"))):
    """ISO 19650 'approval' gate for WIP->Shared — named `review` here (not
    `approve`) to avoid colliding with the pre-existing Shared->Published
    `approve` endpoint below, which maps to ISO 19650's 'authorisation'."""
    from db.connection import get_conn, release_conn
    from db.documents import set_reviewed, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = set_reviewed(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "reviewed", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/review")
def unreview_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("reviewer", "approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_reviewed, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = clear_reviewed(conn, doc_id)
        record_event(conn, doc_id, "unreviewed", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/documents/{doc_id}/approve")
def approve_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import set_approved, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = set_approved(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "approved", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/approve")
def unapprove_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_approved, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = clear_approved(conn, doc_id)
        record_event(conn, doc_id, "unapproved", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/documents/{doc_id}/verify")
def verify_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    """ISO 19650 'verification' gate for Published->Archived. Reuses the
    approver role rather than a distinct verifier tier (confirmed choice —
    keeps provisioning to 3 roles per project instead of 4)."""
    from db.connection import get_conn, release_conn
    from db.documents import set_verified, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = set_verified(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "verified", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/verify")
def unverify_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_verified, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = clear_verified(conn, doc_id)
        record_event(conn, doc_id, "unverified", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/documents/{doc_id}/revise")
async def revise_document(
    stream_id: str, doc_id: str, file: UploadFile,
    user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE)),
):
    """New version upload — status unchanged, every downstream gate
    (reviewed/approved/verified) reset: a revised document must re-earn
    all of them before it can move forward again."""
    from db.connection import get_conn, release_conn
    from db.documents import bump_revision, record_event
    from nextcloud.client import upload_bytes

    content = await file.read()

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        try:
            meta = upload_bytes(doc["nc_path"], content, overwrite=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Nextcloud upload failed: {exc}")
        updated = bump_revision(conn, doc_id, nc_path=doc["nc_path"], size_bytes=meta.get("size"), etag=meta.get("etag"))
        record_event(conn, doc_id, "revised", to_value=f"revision {updated['revision']}", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/{doc_id}/versions")
def list_versions(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from nextcloud.client import list_versions as nc_list_versions

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
    finally:
        release_conn(conn)
    return nc_list_versions(doc["nc_fileid"])


@router.get("/projects/{stream_id}/documents/{doc_id}/versions/{version_id}/download")
def download_version(stream_id: str, doc_id: str, version_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from nextcloud.client import download_version as nc_download_version
    from job_registry import _content_disposition

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
    finally:
        release_conn(conn)
    content = nc_download_version(doc["nc_fileid"], version_id)
    return Response(
        content=content, media_type=doc["mime_type"] or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(f"{version_id}_{doc['filename']}")},
    )


@router.delete("/projects/{stream_id}/documents/{doc_id}")
def delete_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    """Nextcloud delete + local soft-delete tombstone — never hard-delete
    the DB row, so audit history (bim_document_events) survives."""
    from db.connection import get_conn, release_conn
    from db.documents import soft_delete_document, record_event
    from nextcloud.client import delete as nc_delete

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        try:
            nc_delete(doc["nc_path"])
        except Exception as exc:
            logger.warning("Nextcloud delete failed for doc %s (soft-deleting locally anyway): %s", doc_id, exc)
        soft_delete_document(conn, doc_id)
        record_event(conn, doc_id, "deleted", actor=user.name, actor_guid=user.guid)
        return {"deleted": doc_id}
    finally:
        release_conn(conn)


class LinkTopicRequest(BaseModel):
    topic_guid: str


@router.post("/projects/{stream_id}/documents/{doc_id}/link-topic")
def link_topic(stream_id: str, doc_id: str, body: LinkTopicRequest, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    from db.connection import get_conn, release_conn
    from db.documents import link_topic as _link, record_event
    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = _link(conn, doc_id, body.topic_guid)
        record_event(conn, doc_id, "linked_topic", to_value=body.topic_guid, actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/link-topic")
def unlink_topic(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    from db.connection import get_conn, release_conn
    from db.documents import unlink_topic as _unlink, record_event
    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        updated = _unlink(conn, doc_id)
        record_event(conn, doc_id, "unlinked_topic", from_value=doc["linked_bcf_topic"], actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


class LinkElementRequest(BaseModel):
    speckle_id: str


@router.post("/projects/{stream_id}/documents/{doc_id}/link-element")
def link_element(stream_id: str, doc_id: str, body: LinkElementRequest, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    from db.connection import get_conn, release_conn
    from db.documents import link_element as _link, record_event
    conn = get_conn()
    try:
        _require_doc(conn, doc_id)
        updated = _link(conn, doc_id, body.speckle_id)
        record_event(conn, doc_id, "linked_element", to_value=body.speckle_id, actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/link-element")
def unlink_element(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    from db.connection import get_conn, release_conn
    from db.documents import unlink_element as _unlink, record_event
    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id)
        updated = _unlink(conn, doc_id)
        record_event(conn, doc_id, "unlinked_element", from_value=doc["linked_element"], actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.post("/projects/{stream_id}/documents/backfill")
async def backfill_documents(stream_id: str, user: CurrentUser = Depends(require_login)):
    """One-time bulk-index of files already sitting in Nextcloud (e.g.
    uploaded by an admin directly, or migrated from elsewhere) — walks every
    status subfolder and upserts what it finds. Poll the returned job_id."""
    from db.connection import get_conn, release_conn
    from nextcloud.provisioning import ensure_project_group

    try:
        ensure_project_group(stream_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud provisioning failed: {exc}")

    job_id = str(uuid.uuid4())
    conn = get_conn()
    try:
        create_job(conn, job_id, "document_backfill", payload={"stream_id": stream_id})
    finally:
        release_conn(conn)

    async def _run():
        from db.connection import get_conn as _get_conn, release_conn as _release_conn
        from nextcloud.reconcile import reconcile_project

        conn2 = _get_conn()
        try:
            indexed = await asyncio.to_thread(reconcile_project, conn2, stream_id)
            update_job(conn2, job_id, status="complete", result={"indexed": indexed})
        except Exception as exc:
            logger.error("Document backfill job %s failed: %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                prune_jobs(conn2, "document_backfill")
            finally:
                _release_conn(conn2)

    fire_and_forget(_run())
    return {"job_id": job_id, "status": "pending"}


@router.get("/projects/{stream_id}/documents/backfill/{job_id}/status")
def backfill_status(stream_id: str, job_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        job = get_job(conn, job_id)
    finally:
        release_conn(conn)
    if not job:
        raise HTTPException(status_code=404, detail="Backfill job not found")
    return job
