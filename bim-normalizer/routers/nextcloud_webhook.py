"""
Receives Nextcloud webhook_listeners callbacks registered by
nextcloud/webhooks.py — the near-real-time counterpart to
nextcloud/reconcile.py's periodic full-tree fallback sweep. Not
stream-scoped in the URL (a single set of registrations receives events for
every project) — the affected stream_id(s) are derived from the event
payload's own node path(s).
"""
import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException, Request

from nextcloud.webhooks import HEADER_NAME, webhook_secret

router = APIRouter(tags=["nextcloud-webhook"])
logger = logging.getLogger(__name__)

# Confirmed live against this deployment: OCP\Files\Events\Node\*Event's
# FileInfo path is always "/<uid>/files/<rest>" — the path as seen through
# whichever user's own files root the write went through. Group folders are
# mounted into that same per-user view, so a group-folder file's path looks
# like "/admin/files/project-<id>/01_WIP/foo.ifc" regardless of which real
# user's session actually touched it.
_USER_FILES_PREFIX = re.compile(r"^/[^/]+/files/(.+)$")

# A burst of events for the same project (e.g. dragging 50 files into the
# Nextcloud web UI at once, or a rename cascading through a subtree) should
# collapse into one reconcile a few seconds after the last one, not one per
# event — this is a single-process app, so an in-memory per-stream_id task
# map is enough; no external coordination needed.
_DEBOUNCE_SECONDS = 5
_pending: dict[str, asyncio.Task] = {}


def _stream_id_from_path(path: str | None) -> str | None:
    if not path:
        return None
    m = _USER_FILES_PREFIX.match(path)
    if not m:
        return None
    group_folder = m.group(1).split("/", 1)[0]
    if not group_folder.startswith("project-"):
        return None
    return group_folder[len("project-"):]


def _extract_stream_ids(payload: dict) -> set[str]:
    """node (Created/Written/Deleted/Touched events) or source+target
    (Renamed, which also covers plain moves) — whichever the event class
    actually carries; see OCP\\Files\\Events\\Node\\Abstract*Event."""
    event = payload.get("event") or {}
    stream_ids: set[str] = set()
    for key in ("node", "source", "target"):
        node = event.get(key)
        if isinstance(node, dict):
            stream_id = _stream_id_from_path(node.get("path"))
            if stream_id:
                stream_ids.add(stream_id)
    return stream_ids


async def _debounced_reconcile(stream_id: str) -> None:
    try:
        await asyncio.sleep(_DEBOUNCE_SECONDS)
    except asyncio.CancelledError:
        return
    from db.connection import get_conn, release_conn
    from nextcloud.reconcile import reconcile_project

    conn = get_conn()
    try:
        indexed = await asyncio.to_thread(reconcile_project, conn, stream_id)
        logger.info("Webhook-triggered reconcile for %s indexed %d file(s)", stream_id, indexed)
    except Exception:
        logger.exception("Webhook-triggered reconcile failed for %s", stream_id)
    finally:
        release_conn(conn)
        _pending.pop(stream_id, None)


def _schedule_reconcile(stream_id: str) -> None:
    existing = _pending.get(stream_id)
    if existing and not existing.done():
        existing.cancel()
    _pending[stream_id] = asyncio.create_task(_debounced_reconcile(stream_id))


@router.post("/nextcloud-webhook")
async def nextcloud_webhook(request: Request):
    if request.headers.get(HEADER_NAME) != webhook_secret():
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    payload = await request.json()
    stream_ids = _extract_stream_ids(payload)
    for stream_id in stream_ids:
        _schedule_reconcile(stream_id)
    return {"scheduled": sorted(stream_ids)}
