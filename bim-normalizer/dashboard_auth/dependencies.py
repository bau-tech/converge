from dataclasses import dataclass

from fastapi import HTTPException, Request

from config import settings
from dashboard_auth.session import SESSION_COOKIE, decode_session

# Fixed identity used only when settings.DASHBOARD_AUTH_BYPASS is on — a
# stable guid (rather than a fresh one per request) so anything keyed by
# actor_guid stays consistent across a test session.
_BYPASS_USER_GUID = "00000000-0000-0000-0000-000000000000"


@dataclass
class CurrentUser:
    guid: str
    email: str
    name: str


def require_login(request: Request) -> CurrentUser:
    if settings.DASHBOARD_AUTH_BYPASS:
        return CurrentUser(guid=_BYPASS_USER_GUID, email="dev-bypass@local", name="Dev Bypass")
    payload = decode_session(request.cookies.get(SESSION_COOKIE))
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return CurrentUser(guid=payload["sub"], email=payload["email"], name=payload["name"])


# Any CDE role at all — used where an endpoint just needs "some standing on
# this project," not a specific tier (e.g. uploading, deleting, linking).
ANY_PROJECT_ROLE = ("author", "reviewer", "approver")


def require_project_role(conn, stream_id: str, user: CurrentUser, allowed_roles) -> None:
    """Manual (non-Depends) check for callers whose required role depends on
    something only known at runtime — e.g. move_document/set_model_status
    need a different role per *target* status, which a static
    Depends(require_role(...)) on the route can't express since it can't see
    the request body. Use require_role() below instead when the required
    role is fixed for the whole endpoint."""
    if settings.DASHBOARD_AUTH_BYPASS:
        return
    from db.roles import get_user_roles
    roles = get_user_roles(conn, user.guid, stream_id)
    if not roles.intersection(allowed_roles):
        raise HTTPException(
            status_code=403,
            detail=f"Requires one of these project roles: {', '.join(allowed_roles)}",
        )


def require_role(*allowed_roles: str):
    """Dependency factory — the returned dependency declares `stream_id` as a
    plain parameter so FastAPI resolves it from the same path param the
    endpoint itself is mounted under (e.g. /projects/{stream_id}/documents/...),
    without needing the caller to pass it explicitly."""
    def _dependency(stream_id: str, request: Request) -> CurrentUser:
        user = require_login(request)
        from db.connection import get_conn, release_conn
        conn = get_conn()
        try:
            require_project_role(conn, stream_id, user, allowed_roles)
        finally:
            release_conn(conn)
        return user
    return _dependency
