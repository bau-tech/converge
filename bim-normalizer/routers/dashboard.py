from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from dashboard_auth.dependencies import ANY_PROJECT_ROLE, CurrentUser, require_login, require_project_role

router = APIRouter(tags=["dashboard"])

# Dashboard share-link store. Rolling slots share01–share99 (wraps, overwrites oldest).
# Data is lost on restart — share links are short-lived convenience URLs.
_dashboard_shares: Dict[str, Any] = {}
_share_counter = 0


class _ShareBody(BaseModel):
    payload: dict


@router.post("/share")
def create_share(body: _ShareBody, user: CurrentUser = Depends(require_login)):
    """Store a dashboard snapshot and return a short share ID (share01–share99)."""
    global _share_counter
    if not _dashboard_shares:
        _share_counter = 0
    _share_counter = (_share_counter % 99) + 1
    share_id = f"share{_share_counter:02d}"
    server = body.payload.get("server") or {}
    _dashboard_shares[share_id] = {
        "payload": body.payload,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "server_url": server.get("url", "") if isinstance(server, dict) else "",
        "server_name": server.get("name", "") if isinstance(server, dict) else "",
        "project_id": body.payload.get("projectId") or "",
        "model_name": body.payload.get("modelName") or "",
    }
    return {"id": share_id}


@router.get("/share")
def list_shares(user: CurrentUser = Depends(require_login)):
    """List all active share links with their metadata (no payload) — login
    only, not project-scoped since this deliberately spans every project's
    share links for the dashboard's own share-management UI."""
    return sorted(
        [
            {
                "id": sid,
                "created_at": e.get("created_at", ""),
                "server_url": e.get("server_url", ""),
                "server_name": e.get("server_name", ""),
                "project_id": e.get("project_id", ""),
                "model_name": e.get("model_name", ""),
            }
            for sid, e in _dashboard_shares.items()
        ],
        key=lambda x: x["id"],
    )


@router.get("/share/{share_id}")
def get_share(share_id: str):
    """Retrieve a stored dashboard snapshot by share ID. Deliberately
    unauthenticated — a share_id IS the access credential for anonymous
    /shareXXX visitors (see .env.example's VITE_SHARE_LINK_MODE), same as
    every other capability-token-style share link."""
    entry = _dashboard_shares.get(share_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Share link not found or expired")
    return {"payload": entry["payload"]}


@router.delete("/share/{share_id}")
def delete_share(share_id: str, user: CurrentUser = Depends(require_login)):
    """Delete a share link, freeing the slot for reuse."""
    if share_id not in _dashboard_shares:
        raise HTTPException(status_code=404, detail="Share link not found")
    del _dashboard_shares[share_id]
    return {"ok": True}


# ---------------------------------------------------------------------------
# Per-project default dashboard layout
# ---------------------------------------------------------------------------
# Unlike /share (ephemeral, explicitly-created links), this is the one
# persistent layout per project: what a browser with no localStorage state
# yet loads on first visit, instead of the bare grid defaults.

class _DashboardLayoutBody(BaseModel):
    payload: dict


@router.put("/dashboard-layout/{project_id}")
def save_dashboard_layout(project_id: str, body: _DashboardLayoutBody, user: CurrentUser = Depends(require_login)):
    """Save the current dashboard state as this project's default for new visitors.

    project_id here is the same identifier routers/documents.py etc. call
    stream_id (Speckle's own project id) — require_role()'s Depends factory
    can't be used since it binds to a path param literally named stream_id,
    so the role check happens manually once the connection is open instead.
    """
    import json
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        require_project_role(conn, project_id, user, ANY_PROJECT_ROLE)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO bim_dashboard_layouts (project_id, payload, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (project_id) DO UPDATE
                SET payload = EXCLUDED.payload, updated_at = NOW()
            """, (project_id, json.dumps(body.payload)))
        conn.commit()
        return {"ok": True}
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.get("/dashboard-layout/{project_id}")
def get_dashboard_layout(project_id: str):
    """Fetch the saved default dashboard layout for a project, if one exists."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT payload FROM bim_dashboard_layouts WHERE project_id = %s", (project_id,))
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No default layout saved for this project")
        return {"payload": row[0]}
    finally:
        release_conn(conn)
