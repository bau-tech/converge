"""
In-app notification feed (bim_notifications) — personal to the logged-in
user across every project, so these routes sit at the top level rather than
under /projects/{stream_id}/... like documents.py. See notifications/dispatch.py
for where rows get written (fired via job_registry.fire_and_forget_sync
right after each relevant document-workflow event).
"""
from fastapi import APIRouter, Depends

from dashboard_auth.dependencies import CurrentUser, require_login

router = APIRouter(tags=["notifications"])


@router.get("/notifications")
def list_notifications(unread_only: bool = False, limit: int = 50, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.notifications import list_notifications as _list
    conn = get_conn()
    try:
        return _list(conn, user.guid, unread_only=unread_only, limit=limit)
    finally:
        release_conn(conn)


@router.get("/notifications/unread-count")
def notifications_unread_count(user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.notifications import unread_count
    conn = get_conn()
    try:
        return {"count": unread_count(conn, user.guid)}
    finally:
        release_conn(conn)


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int, user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.notifications import mark_read
    conn = get_conn()
    try:
        return {"notification": mark_read(conn, notification_id, user.guid)}
    finally:
        release_conn(conn)


@router.post("/notifications/read-all")
def mark_all_notifications_read(user: CurrentUser = Depends(require_login)):
    from db.connection import get_conn, release_conn
    from db.notifications import mark_all_read
    conn = get_conn()
    try:
        return {"marked_read": mark_all_read(conn, user.guid)}
    finally:
        release_conn(conn)
