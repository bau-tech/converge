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
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from dashboard_auth.dependencies import ANY_PROJECT_ROLE, CurrentUser, require_login, require_project_role, require_role
from db.jobs import create_job, update_job, get_job, prune_jobs
from job_registry import fire_and_forget, fire_and_forget_sync
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


def _sanitize_folder_path(path: str | None) -> str:
    """Client-supplied subfolder paths get concatenated directly into WebDAV
    paths (ensure_folder/upload_bytes/list_folder) — reject '..'/empty
    segments so a caller can't traverse outside the group folder's status
    roots."""
    path = (path or "").strip("/")
    if not path:
        return ""
    if any(seg in ("", ".", "..") for seg in path.split("/")):
        raise HTTPException(status_code=422, detail="Invalid folder path")
    return path


def _latest_model_id(conn, stream_id: str) -> str | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT model_id FROM bim_models WHERE stream_id = %s ORDER BY ingested_at DESC LIMIT 1",
            (stream_id,),
        )
        row = cur.fetchone()
    return str(row[0]) if row else None


def _require_doc(conn, doc_id: str, user: CurrentUser) -> dict:
    """404s (not 403 — don't leak existence) if doc_id doesn't exist, is
    soft-deleted, or is a WIP document scoped to an org the caller isn't in.
    Mirrors list_documents' visibility filter (db/documents.py) so a
    guessed/bookmarked doc_id can't see more than the list endpoint does."""
    from db.documents import get_document
    doc = get_document(conn, doc_id)
    if doc is None or doc["deleted_at"] is not None:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc["status"] == "WIP" and doc["org_id"] and user.org_id and doc["org_id"] != user.org_id:
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
        return _list(conn, stream_id, status=status, linked_element=linked_element, viewer_org_id=user.org_id)
    finally:
        release_conn(conn)


def _run_on_each_status_root(fn) -> None:
    """Run fn(status_subfolder) once per status root (WIP/Shared/Published/
    Archived) concurrently instead of one at a time — these 4 Nextcloud calls
    never depend on each other, so the old sequential loop paid 4x the
    round-trip latency for no reason. Used by create_folder/rename_folder/
    delete_folder below; each fn already does its own error handling
    (propagate vs. log-and-continue), so this only changes the scheduling."""
    with ThreadPoolExecutor(max_workers=len(_STATUS_FOLDERS)) as pool:
        for _ in pool.map(fn, _STATUS_FOLDERS.values()):
            pass


def _union_subfolder_names(group_folder: str, path: str) -> set[str]:
    """Subfolder names at `path`, unioned across all 4 status roots — a
    folder is one logical thing spanning the whole WIP->Shared->Published->
    Archived workflow (see create_folder), and may exist asymmetrically if
    created/renamed directly in Nextcloud under only one status root.
    Shared by list_subfolders (below) and rename_folder's destination-name
    collision check. The 4 PROPFINDs run concurrently (see
    _run_on_each_status_root) — they're independent reads, no reason to
    serialize them."""
    from nextcloud.client import list_folder as nc_list_folder

    def _list(status_sub: str) -> list[dict]:
        base = f"{group_folder}/{status_sub}/{path}" if path else f"{group_folder}/{status_sub}"
        return nc_list_folder(base, depth="1")

    names: set[str] = set()
    with ThreadPoolExecutor(max_workers=len(_STATUS_FOLDERS)) as pool:
        for entries in pool.map(_list, _STATUS_FOLDERS.values()):
            names.update(e["name"] for e in entries if e["is_dir"])
    return names


@router.get("/projects/{stream_id}/documents/folders")
def list_subfolders(stream_id: str, path: str = "", user: CurrentUser = Depends(require_login)):
    """Must stay registered before GET /documents/{doc_id} below, same
    reason linked-positions already has to be — an untyped `{doc_id}: str`
    path param would otherwise swallow the literal "folders" segment.
    Read-only: list_folder() already returns [] for a not-yet-provisioned
    group folder, no ensure_project_group() needed."""
    sub = _sanitize_folder_path(path)
    group_folder = _group_folder(stream_id)
    try:
        names = _union_subfolder_names(group_folder, sub)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud folder listing failed: {exc}")
    return {"path": sub, "folders": sorted(names)}


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
        doc = _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
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
    implemented, deliberately deprioritized).

    Result is cached in bim_document_thumbnails keyed by (nc_fileid, etag) —
    every source below used to redo its work (a Nextcloud preview round trip,
    or a full file download + DWG/DXF/PDF conversion) on every single
    request, for every viewer, forever. A cache hit skips all Nextcloud I/O
    entirely; a miss renders once and the next request for the same file
    version is a hit. A new etag (bump_revision on /revise) naturally misses
    and re-renders, never serving a stale thumbnail."""
    from config import settings
    from db.connection import get_conn, release_conn
    from db.documents import get_cached_thumbnail, cache_thumbnail

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id, user)
        cached = get_cached_thumbnail(conn, doc["nc_fileid"], doc["etag"])
    finally:
        release_conn(conn)
    if cached is not None:
        content_type, content = cached
        return Response(content=content, media_type=content_type)

    from nextcloud.client import _auth, _session
    resp = _session.get(
        f"{settings.NEXTCLOUD_URL}/index.php/core/preview",
        params={"fileId": doc["nc_fileid"], "x": 256, "y": 256, "a": "1"},
        auth=_auth(), timeout=30,
    )
    content_type: str | None = None
    content: bytes | None = None

    if resp.status_code == 200:
        content_type = resp.headers.get("Content-Type", "image/png")
        content = resp.content
    else:
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
                content = render_dxf_thumbnail(raw)
                content_type = "image/png"
            except DxfThumbnailError as exc:
                raise HTTPException(status_code=404, detail=f"No preview available: {exc}")
        elif filename.endswith(".pdf"):
            from nextcloud.client import download_bytes
            from pdf_thumbnail import render_pdf_thumbnail, PdfThumbnailError

            raw = download_bytes(doc["nc_path"])
            try:
                content = render_pdf_thumbnail(raw)
                content_type = "image/png"
            except PdfThumbnailError as exc:
                raise HTTPException(status_code=404, detail=f"No preview available: {exc}")
        else:
            raise HTTPException(status_code=404, detail="No preview available")

    if doc["etag"]:
        conn = get_conn()
        try:
            cache_thumbnail(conn, doc["nc_fileid"], doc["etag"], content_type, content)
        finally:
            release_conn(conn)
    return Response(content=content, media_type=content_type)


@router.post("/projects/{stream_id}/documents/upload")
async def upload_document(
    stream_id: str, file: UploadFile,
    doc_type: str = Form("document"),
    model_id: str | None = Form(None),
    folder_path: str | None = Form(None),
    user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE)),
):
    """Always lands in 01_WIP — new documents must go through the approval
    workflow before reaching Published, same as everything else.

    doc_type='drawing' requires an explicit model_id — deliberately not
    falling back to _latest_model_id() the way generic documents do below,
    since a drawing's model link is meant to be a deliberate user choice,
    not a best-effort guess.

    folder_path (optional) places the upload inside a subfolder of WIP —
    see create_folder() below for how a folder comes to exist across all
    4 status roots in the first place."""
    from db.connection import get_conn, release_conn
    from db.documents import upsert_document, record_event
    from nextcloud.client import upload_bytes, ensure_folder
    from nextcloud.provisioning import ensure_project_group

    if doc_type not in _VALID_DOC_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid doc_type, must be one of {_VALID_DOC_TYPES}")

    sub = _sanitize_folder_path(folder_path)
    content = await file.read()
    filename = file.filename or "document"
    group_folder = _group_folder(stream_id)
    target_dir = f"{group_folder}/{_STATUS_FOLDERS['WIP']}/{sub}" if sub else f"{group_folder}/{_STATUS_FOLDERS['WIP']}"

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
        if sub:
            # Defensive/idempotent (MKCOL 405s harmlessly if it already
            # exists via create_folder) — removes any hard ordering
            # dependency on the client having called that route first.
            ensure_folder(target_dir)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud provisioning failed: {exc}")

    try:
        meta = upload_bytes(f"{target_dir}/{filename}", content, overwrite=False)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud upload failed: {exc}")

    conn = get_conn()
    try:
        doc = upsert_document(
            conn, stream_id=stream_id, model_id=model_id,
            nc_fileid=meta["fileid"], nc_path=meta["path"], nc_group_folder=group_folder,
            filename=meta["name"], mime_type=meta.get("mime_type"), size_bytes=meta.get("size"),
            etag=meta.get("etag"), status="WIP", doc_type=doc_type, org_id=user.org_id,
        )
        record_event(conn, doc["doc_id"], "created", to_value="WIP", actor=user.name, actor_guid=user.guid)
    finally:
        release_conn(conn)
    from notifications.dispatch import notify_document_event
    fire_and_forget_sync(notify_document_event, stream_id, doc["doc_id"], "created", None, user.guid)
    return doc


class CreateFolderRequest(BaseModel):
    parent_path: str = ""
    name: str


@router.post("/projects/{stream_id}/documents/folders")
def create_folder(
    stream_id: str, body: CreateFolderRequest,
    user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE)),
):
    """Creates one logical folder spanning all 4 status roots at once
    (ensure_folder x4) — a folder is one thing across the whole WIP->
    Shared->Published->Archived workflow, not 4 independent trees (see
    move_document's subfolder-preservation below). parent_path must already
    exist (MKCOL requires an existing parent) — never an issue in practice
    since the frontend only ever creates one level at a time from wherever
    it's currently browsing, which by construction is a path it already
    navigated into via list_subfolders()."""
    from nextcloud.client import ensure_folder
    from nextcloud.provisioning import ensure_project_group

    name = body.name.strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(status_code=422, detail="Invalid folder name")
    parent = _sanitize_folder_path(body.parent_path)
    folder_path = f"{parent}/{name}" if parent else name

    try:
        ensure_project_group(stream_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud provisioning failed: {exc}")

    group_folder = _group_folder(stream_id)
    try:
        _run_on_each_status_root(lambda sub: ensure_folder(f"{group_folder}/{sub}/{folder_path}"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud folder creation failed: {exc}")

    return {"path": folder_path, "name": name}


@router.delete("/projects/{stream_id}/documents/folders")
def delete_folder(stream_id: str, path: str, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    """Recursively deletes a folder and everything inside it, across all 4
    status roots. Every affected bim_documents row (any status, this folder
    or a nested one beneath it) is soft-deleted first — same as
    delete_document, audit history (bim_document_events) survives, never a
    hard DB delete — then the actual Nextcloud folders are removed.
    Nextcloud's WebDAV DELETE on a collection is recursive by spec, which is
    exactly the "delete folder and its contents" behaviour wanted here."""
    from db.connection import get_conn, release_conn
    from db.documents import list_documents as _list_docs, soft_delete_document, record_event
    from nextcloud.client import delete as nc_delete

    folder_path = _sanitize_folder_path(path)
    if not folder_path:
        raise HTTPException(status_code=422, detail="Cannot delete the root")

    group_folder = _group_folder(stream_id)
    conn = get_conn()
    try:
        # viewer_org_id here isn't just a display filter — it keeps a user
        # scoped to one org from bulk-deleting another org's WIP documents
        # just because they happen to sit under a folder path this user can
        # otherwise reach.
        docs = _list_docs(conn, stream_id, viewer_org_id=user.org_id)
        # Prefix match (not equality) so a nested subfolder's documents are
        # caught too — deleting "Structural" must also remove anything
        # under "Structural/SubA".
        affected = [
            d for d in docs
            if d["nc_path"].startswith(f"{group_folder}/{_STATUS_FOLDERS[d['status']]}/{folder_path}/")
        ]
        for doc in affected:
            soft_delete_document(conn, doc["doc_id"])
            record_event(conn, doc["doc_id"], "deleted", actor=user.name, actor_guid=user.guid)
    finally:
        release_conn(conn)

    # Best-effort per status root — a root that never had this folder (see
    # the asymmetric-folder reasoning throughout this file) 404s harmlessly
    # via nc_delete's own tolerance; any other failure is logged rather than
    # aborting the loop, since partial cleanup is still strictly better than
    # none and the DB side (the part users actually see) is already done.
    def _delete_one(sub: str) -> None:
        try:
            nc_delete(f"{group_folder}/{sub}/{folder_path}")
        except Exception as exc:
            logger.warning("delete_folder: failed to remove %s/%s: %s", sub, folder_path, exc)

    _run_on_each_status_root(_delete_one)

    return {"deleted": folder_path, "documents_removed": len(affected)}


class RenameFolderRequest(BaseModel):
    path: str
    new_name: str


@router.post("/projects/{stream_id}/documents/folders/rename")
def rename_folder(stream_id: str, body: RenameFolderRequest, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    """Renames a folder (its last path segment) across all 4 status roots,
    then rewrites nc_path for every affected bim_documents row.

    Checks for a destination-name collision *before* touching anything —
    without this, a partial failure (Nextcloud MOVE returns 409/412 for an
    already-existing destination on some status root but not others, and
    nc_move()/client.py doesn't distinguish that from "source didn't exist
    here" 404s) could leave some status roots renamed and others not, with
    no reliable signal to tell the two failure modes apart afterward. With
    the upfront check, the only expected per-root failure left is "this
    status root never had the folder" — tolerable, same reasoning as
    create_folder/list_subfolders."""
    from db.connection import get_conn, release_conn
    from db.documents import list_documents as _list_docs, update_nc_path, record_event
    from nextcloud.client import move as nc_move

    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or new_name in (".", ".."):
        raise HTTPException(status_code=422, detail="Invalid folder name")
    old_path = _sanitize_folder_path(body.path)
    if not old_path:
        raise HTTPException(status_code=422, detail="Cannot rename the root")

    parent, _, _old_name = old_path.rpartition("/")
    new_path = f"{parent}/{new_name}" if parent else new_name
    if new_path == old_path:
        return {"path": old_path}

    group_folder = _group_folder(stream_id)
    try:
        existing = _union_subfolder_names(group_folder, parent)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Nextcloud folder listing failed: {exc}")
    if new_name in existing:
        raise HTTPException(status_code=409, detail=f'A folder named "{new_name}" already exists here')

    def _move_one(sub: str) -> None:
        try:
            nc_move(f"{group_folder}/{sub}/{old_path}", f"{group_folder}/{sub}/{new_path}")
        except Exception as exc:
            logger.warning("rename_folder: failed to move %s/%s -> %s: %s", sub, old_path, new_path, exc)

    _run_on_each_status_root(_move_one)

    conn = get_conn()
    try:
        docs = _list_docs(conn, stream_id)
        updated = 0
        for d in docs:
            status_sub = _STATUS_FOLDERS[d["status"]]
            old_prefix = f"{group_folder}/{status_sub}/{old_path}/"
            if d["nc_path"].startswith(old_prefix):
                new_nc_path = f"{group_folder}/{status_sub}/{new_path}/" + d["nc_path"][len(old_prefix):]
                update_nc_path(conn, d["doc_id"], new_nc_path)
                record_event(conn, d["doc_id"], "folder_renamed", from_value=d["nc_path"], to_value=new_nc_path, actor=user.name, actor_guid=user.guid)
                updated += 1
    finally:
        release_conn(conn)

    return {"path": new_path, "documents_updated": updated}


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
        doc = _require_doc(conn, doc_id, user)
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

        # Preserve whatever subfolder the document is currently in — the old
        # flat reconstruction below silently dropped it on every status
        # change. doc["nc_path"] is already authoritative (same pattern
        # revise_document uses), so derive the subfolder from its prefix
        # rather than assuming a flat group_folder/status/filename shape.
        old_path = doc["nc_path"]
        prefix = f"{group_folder}/{old_folder}/"
        subfolder = ""
        if old_path.startswith(prefix):
            remainder = old_path[len(prefix):]  # "{subfolder/}filename" or "filename"
            subfolder, _, _ = remainder.rpartition("/")

        new_dir = f"{group_folder}/{new_folder}/{subfolder}" if subfolder else f"{group_folder}/{new_folder}"
        new_path = f"{new_dir}/{doc['filename']}"
        try:
            from nextcloud.client import ensure_folder
            if subfolder:
                # Defensive: the destination status root should already have
                # this subfolder (create_folder() makes it in all 4 at
                # once), but idempotent MKCOL costs nothing and guards races.
                ensure_folder(new_dir)
            nc_move(old_path, new_path)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Nextcloud move failed: {exc}")

        updated = set_status(conn, doc_id, body.status, new_path)
        record_event(conn, doc_id, "moved", from_value=doc["status"], to_value=body.status, actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "moved", body.status, user.guid)
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
        _require_doc(conn, doc_id, user)
        updated = set_reviewed(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "reviewed", actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "reviewed", None, user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/review")
def unreview_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("reviewer", "approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_reviewed, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id, user)
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
        _require_doc(conn, doc_id, user)
        updated = set_approved(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "approved", actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "approved", None, user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/approve")
def unapprove_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_approved, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id, user)
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
        _require_doc(conn, doc_id, user)
        updated = set_verified(conn, doc_id, user.name, user.guid)
        record_event(conn, doc_id, "verified", actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "verified", None, user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/verify")
def unverify_document(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role("approver"))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_verified, record_event

    conn = get_conn()
    try:
        _require_doc(conn, doc_id, user)
        updated = clear_verified(conn, doc_id)
        record_event(conn, doc_id, "unverified", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


class SuitabilityRequest(BaseModel):
    code: str


@router.patch("/projects/{stream_id}/documents/{doc_id}/suitability")
def set_document_suitability(stream_id: str, doc_id: str, body: SuitabilityRequest,
                              user: CurrentUser = Depends(require_role("approver"))):
    """ISO 19650 'purpose of issue' suitability code — advisory, distinct
    from both `status` (container state) and `revision` (plain version
    counter). Gated to approver, same tier as approve/verify. Reset to NULL
    on every bump_revision() (see db/documents.py) — a new revision must be
    re-declared, not inherit its predecessor's code."""
    from naming.suitability import SUITABILITY_CODES
    from db.connection import get_conn, release_conn
    from db.documents import set_suitability_code, record_event

    if body.code not in SUITABILITY_CODES:
        raise HTTPException(status_code=400, detail=f"Invalid suitability code, must be one of {list(SUITABILITY_CODES)}")

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id, user)
        updated = set_suitability_code(conn, doc_id, body.code, user.name, user.guid)
        record_event(conn, doc_id, "suitability_set", from_value=doc.get("suitability_code"), to_value=body.code, actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "suitability_set", body.code, user.guid)
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
        doc = _require_doc(conn, doc_id, user)
        try:
            meta = upload_bytes(doc["nc_path"], content, overwrite=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Nextcloud upload failed: {exc}")
        updated = bump_revision(conn, doc_id, nc_path=doc["nc_path"], size_bytes=meta.get("size"), etag=meta.get("etag"))
        record_event(conn, doc_id, "revised", to_value=f"revision {updated['revision']}", actor=user.name, actor_guid=user.guid)
        from notifications.dispatch import notify_document_event
        fire_and_forget_sync(notify_document_event, stream_id, doc_id, "revised", f"revision {updated['revision']}", user.guid)
        return updated
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/{doc_id}/versions")
def list_versions(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from nextcloud.client import list_versions as nc_list_versions

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
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
        _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
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
        _require_doc(conn, doc_id, user)
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
        doc = _require_doc(conn, doc_id, user)
        updated = _unlink(conn, doc_id)
        record_event(conn, doc_id, "unlinked_element", from_value=doc["linked_element"], actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


class AlignmentPoint(BaseModel):
    drawing: dict  # {x, y} — true (unshifted) DXF modelspace coordinates
    world: dict    # {x, y, z} — Speckle viewer world coordinates


class AlignmentTransform(BaseModel):
    tx: float
    ty: float
    rotation_rad: float
    scale: float


class AlignmentSetRequest(BaseModel):
    transform: AlignmentTransform
    elevation_z: float
    model_id: str
    control_points: list[AlignmentPoint]


@router.post("/projects/{stream_id}/documents/{doc_id}/align")
def set_document_alignment(stream_id: str, doc_id: str, body: AlignmentSetRequest, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    """Saves a 2D-similarity transform (computed client-side by
    src/utils/alignmentTransform.js from a 2-point-pair calibration) that
    positions this drawing as an overlay plane in the 3D viewer. Overwrites
    any existing alignment — see bim_documents.align_* column comments
    (db/models.py) for why this is 1 active alignment per document, not a
    history."""
    from db.connection import get_conn, release_conn
    from db.documents import set_alignment as _set, record_event
    conn = get_conn()
    try:
        _require_doc(conn, doc_id, user)
        if not _model_belongs_to_stream(conn, stream_id, body.model_id):
            raise HTTPException(status_code=422, detail="model_id does not belong to this project")
        updated = _set(
            conn, doc_id,
            transform=body.transform.model_dump(), elevation_z=body.elevation_z, model_id=body.model_id,
            control_points=[p.model_dump() for p in body.control_points],
            actor=user.name, actor_guid=user.guid,
        )
        record_event(conn, doc_id, "aligned", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.delete("/projects/{stream_id}/documents/{doc_id}/align")
def clear_document_alignment(stream_id: str, doc_id: str, user: CurrentUser = Depends(require_role(*ANY_PROJECT_ROLE))):
    from db.connection import get_conn, release_conn
    from db.documents import clear_alignment as _clear, record_event
    conn = get_conn()
    try:
        _require_doc(conn, doc_id, user)
        updated = _clear(conn, doc_id)
        record_event(conn, doc_id, "unaligned", actor=user.name, actor_guid=user.guid)
        return updated
    finally:
        release_conn(conn)


@router.get("/projects/{stream_id}/documents/{doc_id}/align-texture.png")
def document_align_texture(
    stream_id: str, doc_id: str,
    scale: float | None = Query(None, description="Alignment transform's world-units-per-drawing-unit factor — when known, sizes the texture off the drawing's real physical size instead of a flat pixel cap. See dxf_texture_export.py."),
    user: CurrentUser = Depends(require_login),
):
    """Renders this drawing to a transparent PNG for use as the 3D overlay
    plane's texture, plus the exact modelspace extents used (as response
    headers) so the frontend can map the plane's UV space back to true
    drawing coordinates — see dxf_texture_export.py for why this differs
    from the existing /thumbnail route (transparent background, pinned
    extents, higher resolution) rather than reusing it outright."""
    from db.connection import get_conn, release_conn
    from dxf_texture_export import render_dxf_texture, DxfTextureExportError
    from nextcloud.client import download_bytes

    conn = get_conn()
    try:
        doc = _require_doc(conn, doc_id, user)
    finally:
        release_conn(conn)

    filename = doc["filename"].lower()
    if not (filename.endswith(".dxf") or filename.endswith(".dwg")):
        raise HTTPException(status_code=400, detail="Not a .dxf or .dwg document")

    raw = download_bytes(doc["nc_path"])
    if filename.endswith(".dwg"):
        from dwg_convert import convert_dwg_to_dxf, DwgConversionError
        try:
            raw = convert_dwg_to_dxf(raw)
        except DwgConversionError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    try:
        png, (extmin_x, extmin_y, extmax_x, extmax_y) = render_dxf_texture(raw, scale=scale)
    except DxfTextureExportError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return Response(
        content=png, media_type="image/png",
        headers={
            "X-Extent-Min-X": repr(extmin_x), "X-Extent-Min-Y": repr(extmin_y),
            "X-Extent-Max-X": repr(extmax_x), "X-Extent-Max-Y": repr(extmax_y),
            "Access-Control-Expose-Headers": "X-Extent-Min-X, X-Extent-Min-Y, X-Extent-Max-X, X-Extent-Max-Y",
        },
    )


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
