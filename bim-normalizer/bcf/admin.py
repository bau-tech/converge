"""
Standalone admin web page for bcf-server.

Deliberately NOT part of the dashboard's React app — plain HTML + vanilla JS
served directly by this process, no templating engine and no build step,
matching the existing convention in bcf/oauth.py's login form.

Auth is a real login form against bcf_users (not the shared BCF_API_KEY —
that key never has to touch the browser). On success it issues a signed
session cookie using the same jwt.encode/BCF_OIDC_SECRET-derived-key pattern
oauth.py uses for its id_token, but with a distinct signing key and a
"purpose" claim, so a token issued for one can never be replayed as the
other.
"""
import hashlib
import time

import jwt
from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from config import settings
from bcf.db import execute, fetch_all, fetch_one, execute_returning
from bcf.password import hash_password, verify_password
from bcf.schemas import UserCreate
from db.purge import purge_speckle_models

router = APIRouter(tags=["bcf-admin"])

SESSION_COOKIE = "bcf_admin_session"
SESSION_TTL_SECONDS = 8 * 3600

_SIGNING_KEY = hashlib.sha256(f"{settings.BCF_OIDC_SECRET}:admin".encode()).digest()


def _esc(v) -> str:
    return (v or "").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def _create_session_token(email: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": email, "iat": now, "exp": now + SESSION_TTL_SECONDS, "purpose": "bcf_admin"},
        _SIGNING_KEY,
        algorithm="HS256",
    )


def _decode_session(token: str | None) -> str | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, _SIGNING_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if payload.get("purpose") != "bcf_admin":
        return None
    return payload.get("sub")


def require_admin_session(request: Request) -> str:
    email = _decode_session(request.cookies.get(SESSION_COOKIE))
    if not email:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return email


# ---------------------------------------------------------------------------
# Login / logout
# ---------------------------------------------------------------------------

def _login_page_html(error: str | None = None) -> str:
    error_html = f'<p class="error">{_esc(error)}</p>' if error else ""
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>bcf-server admin</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #111; color: #eee;
          display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }}
  form {{ background: #1c1c1c; padding: 2rem; border-radius: 8px; width: 280px; }}
  h1 {{ font-size: 1.1rem; margin: 0 0 1rem; }}
  label {{ display: block; font-size: 0.85rem; margin-bottom: 0.9rem; }}
  input {{ width: 100%; margin-top: 0.3rem; padding: 0.5rem; border-radius: 4px;
           border: 1px solid #444; background: #0d0d0d; color: #eee; box-sizing: border-box; }}
  button {{ width: 100%; padding: 0.6rem; border-radius: 4px; border: none;
            background: #d97706; color: #111; font-weight: 600; cursor: pointer; }}
  .error {{ color: #f87171; font-size: 0.85rem; }}
</style></head><body>
  <form method="post" action="/admin/login">
    <h1>bcf-server admin</h1>
    {error_html}
    <label>Email<input type="email" name="email" required autofocus></label>
    <label>Password<input type="password" name="password" required></label>
    <button type="submit">Sign in</button>
  </form>
</body></html>"""


@router.get("/admin/login")
def login_form():
    return HTMLResponse(_login_page_html())


@router.post("/admin/login")
def login_submit(request: Request, email: str = Form(...), password: str = Form(...)):
    user = fetch_one("SELECT email, password_hash FROM bcf_users WHERE email = %s", (email,))
    if user is None or not verify_password(password, user["password_hash"]):
        return HTMLResponse(_login_page_html(error="Invalid email or password"), status_code=401)
    resp = RedirectResponse("/admin", status_code=302)
    resp.set_cookie(
        SESSION_COOKIE, _create_session_token(user["email"]),
        # request.url.scheme reflects X-Forwarded-Proto when reached through the
        # reverse proxy (bcf_server.py runs uvicorn with proxy_headers=True), but
        # the exposed container port (8004:8004) is also reachable directly over
        # plain HTTP — a hardcoded secure=True there would have the browser
        # silently drop the cookie, making login look like it's rejecting valid
        # credentials when it actually never persisted the session at all.
        max_age=SESSION_TTL_SECONDS, httponly=True, samesite="lax", secure=request.url.scheme == "https",
    )
    return resp


@router.get("/admin/logout")
def logout():
    resp = RedirectResponse("/admin/login", status_code=302)
    resp.delete_cookie(SESSION_COOKIE)
    return resp


# ---------------------------------------------------------------------------
# Admin page (vanilla JS, fetches the JSON API below)
# ---------------------------------------------------------------------------

def _admin_page_html(email: str) -> str:
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>bcf-server admin</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 0; padding: 2rem; }}
  h1 {{ font-size: 1.2rem; }}
  h2 {{ font-size: 1rem; color: #aaa; margin-top: 2.5rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.75rem; }}
  th, td {{ text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #2a2a2a; }}
  th {{ color: #888; font-weight: 500; }}
  tr.group-header td {{ color: #d97706; font-weight: 600; padding-top: 1rem; border-bottom: none; }}
  button {{ padding: 0.3rem 0.6rem; border-radius: 4px; border: none; cursor: pointer;
            background: #2a2a2a; color: #eee; font-size: 0.8rem; }}
  button.danger {{ background: #7f1d1d; }}
  button:hover {{ opacity: 0.85; }}
  form.inline {{ display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }}
  input {{ padding: 0.4rem; border-radius: 4px; border: 1px solid #444; background: #0d0d0d; color: #eee; }}
  .topbar {{ display: flex; justify-content: space-between; align-items: baseline; }}
  .muted {{ color: #888; font-size: 0.8rem; }}
  a {{ color: #d97706; text-decoration: none; }}
  .issues-body {{ padding: 0.5rem 0.2rem; }}
  .issue {{ padding: 0.6rem 0; border-bottom: 1px solid #232323; }}
  .issue:last-child {{ border-bottom: none; }}
  .issue-head {{ display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; font-size: 0.82rem; }}
  .issue-snaps {{ display: flex; gap: 0.4rem; margin-top: 0.5rem; flex-wrap: wrap; }}
  .issue-snaps img {{ width: 84px; height: 60px; object-fit: cover; border-radius: 4px; border: 1px solid #2a2a2a; }}
  .error {{ color: #f87171; font-size: 0.85rem; }}
</style></head><body>
  <div class="topbar">
    <h1>bcf-server admin</h1>
    <span class="muted">{_esc(email)} &middot; <a href="/admin/logout">log out</a></span>
  </div>

  <h2>Users</h2>
  <form class="inline" id="create-user-form">
    <input type="email" name="email" placeholder="Email" required>
    <input type="text" name="name" placeholder="Name" required>
    <input type="password" name="password" placeholder="Password" required>
    <button type="submit">Add user</button>
  </form>
  <table id="users-table"><thead><tr><th>Name</th><th>Email</th><th>Created</th><th></th></tr></thead>
    <tbody></tbody></table>

  <h2>Ingested models &amp; sync status</h2>
  <table id="servers-table"><thead><tr><th>Server</th><th>Auto-sync</th><th>Watched streams</th><th>Last scanned</th></tr></thead>
    <tbody></tbody></table>
  <table id="models-table"><thead><tr><th>Stream</th><th>Commit</th><th>Server</th><th>Topics</th><th>Ingested</th><th></th></tr></thead>
    <tbody></tbody></table>

<script>
async function api(path, options) {{
    const res = await fetch(path, options);
    if (res.status === 401) {{ window.location = '/admin/login'; throw new Error('unauthenticated'); }}
    if (!res.ok) throw new Error((await res.json().catch(() => ({{}}))).detail || res.statusText);
    return res.status === 204 ? null : res.json();
}}

function esc(s) {{ return (s ?? '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;'); }}

async function loadUsers() {{
    const users = await api('/admin/api/users');
    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = users.map(u => `<tr>
        <td>${{esc(u.name)}}</td><td>${{esc(u.email)}}</td>
        <td>${{esc(new Date(u.created_at).toLocaleString())}}</td>
        <td><button class="danger" data-guid="${{u.guid}}" onclick="deleteUser(this)">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No users yet.</td></tr>';
}}

async function deleteUser(btn) {{
    if (!confirm('Delete this user?')) return;
    await api(`/admin/api/users/${{btn.dataset.guid}}`, {{ method: 'DELETE' }});
    loadUsers();
}}

document.getElementById('create-user-form').addEventListener('submit', async (e) => {{
    e.preventDefault();
    const f = e.target;
    await api('/admin/api/users', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ email: f.email.value, name: f.name.value, password: f.password.value }}),
    }});
    f.reset();
    loadUsers();
}});

async function loadOverview() {{
    const {{ models, servers }} = await api('/admin/api/overview');

    document.querySelector('#servers-table tbody').innerHTML = servers.map(s => `<tr>
        <td>${{esc(s.server_url)}}</td>
        <td>${{s.enabled ? 'on' : 'off'}}</td>
        <td>${{s.watched_streams}}</td>
        <td>${{s.last_scanned_at ? esc(new Date(s.last_scanned_at).toLocaleString()) : '—'}}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No servers registered.</td></tr>';

    const byStream = {{}};
    for (const m of models) (byStream[m.stream_id] ??= []).push(m);

    const rows = [];
    for (const [streamId, versions] of Object.entries(byStream)) {{
        rows.push(`<tr class="group-header"><td colspan="4">${{esc(streamId)}}</td>
            <td colspan="2"><button class="danger" data-stream="${{streamId}}" onclick="purgeStream(this)">Purge entire project</button></td></tr>`);
        for (const m of versions) {{
            rows.push(`<tr>
                <td></td><td>${{esc(m.commit_id)}}</td><td>${{esc(m.server_url) || '<span class="muted">(none)</span>'}}</td>
                <td>${{m.topic_count}}</td><td>${{esc(new Date(m.ingested_at).toLocaleString())}}</td>
                <td>
                    <button data-model="${{m.model_id}}" onclick="toggleIssues(this)">Issues</button>
                    <button class="danger" data-model="${{m.model_id}}" onclick="purgeModel(this)">Delete version</button>
                </td>
            </tr>`);
            rows.push(`<tr class="issues-row" data-issues-for="${{m.model_id}}" style="display:none">
                <td colspan="6"><div class="issues-body muted">Loading…</div></td>
            </tr>`);
        }}
    }}
    document.querySelector('#models-table tbody').innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">No models ingested.</td></tr>';
}}

async function toggleIssues(btn) {{
    const modelId = btn.dataset.model;
    const row = document.querySelector(`tr.issues-row[data-issues-for="${{modelId}}"]`);
    if (row.style.display === 'none') {{
        row.style.display = '';
        if (!row.dataset.loaded) {{
            row.dataset.loaded = '1';
            await loadIssuesInto(row, modelId);
        }}
    }} else {{
        row.style.display = 'none';
    }}
}}

async function loadIssuesInto(row, modelId) {{
    const body = row.querySelector('.issues-body');
    try {{
        const topics = await api(`/admin/api/models/${{modelId}}/topics`);
        body.innerHTML = topics.length ? topics.map(t => `<div class="issue">
            <div class="issue-head">
                <strong>${{esc(t.title)}}</strong>
                <span class="muted">${{esc(t.topic_status)}}${{t.priority ? ' &middot; ' + esc(t.priority) : ''}}</span>
                ${{t.assigned_to ? `<span class="muted">assigned to ${{esc(t.assigned_to)}}</span>` : ''}}
                <span class="muted">${{t.comment_count}} comment${{t.comment_count !== 1 ? 's' : ''}}</span>
                <span class="muted">${{esc(new Date(t.creation_date).toLocaleString())}}</span>
            </div>
            ${{t.snapshot_viewpoint_guids.length ? `<div class="issue-snaps">${{t.snapshot_viewpoint_guids.map(vg =>
                `<a href="/admin/api/viewpoints/${{vg}}/snapshot" target="_blank"><img loading="lazy" src="/admin/api/viewpoints/${{vg}}/snapshot"></a>`
            ).join('')}}</div>` : ''}}
        </div>`).join('') : '<div class="muted">No issues tracked for this version.</div>';
    }} catch (e) {{
        body.innerHTML = `<span class="error">Failed to load issues: ${{esc(e.message)}}</span>`;
    }}
}}

async function purgeModel(btn) {{
    if (!confirm('Permanently delete this version and any linked BCF topics?')) return;
    await api(`/admin/api/models/${{btn.dataset.model}}`, {{ method: 'DELETE' }});
    loadOverview();
}}

async function purgeStream(btn) {{
    if (!confirm('Permanently delete EVERY version of this project and any linked BCF topics?')) return;
    await api(`/admin/api/streams/${{btn.dataset.stream}}`, {{ method: 'DELETE' }});
    loadOverview();
}}

loadUsers();
loadOverview();
</script>
</body></html>"""


@router.get("/admin")
def admin_page(request: Request):
    email = _decode_session(request.cookies.get(SESSION_COOKIE))
    if not email:
        return RedirectResponse("/admin/login", status_code=302)
    return HTMLResponse(_admin_page_html(email))


# ---------------------------------------------------------------------------
# JSON API (session-cookie authenticated — distinct from the BCF_API_KEY-
# gated /bcf-bridge/users JSON API in bcf/users.py, which stays untouched)
# ---------------------------------------------------------------------------

def _serialize_user(row: dict) -> dict:
    return {
        "guid": str(row["guid"]),
        "email": row["email"],
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/admin/api/users")
def admin_list_users(_email: str = Depends(require_admin_session)):
    rows = fetch_all("SELECT guid, email, name, created_at FROM bcf_users ORDER BY created_at")
    return [_serialize_user(r) for r in rows]


@router.post("/admin/api/users", status_code=201)
def admin_create_user(body: UserCreate, _email: str = Depends(require_admin_session)):
    existing = fetch_one("SELECT guid FROM bcf_users WHERE email = %s", (body.email,))
    if existing is not None:
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    row = execute_returning(
        """
        INSERT INTO bcf_users (email, name, password_hash)
        VALUES (%s, %s, %s)
        RETURNING guid, email, name, created_at
        """,
        (body.email, body.name, hash_password(body.password)),
    )
    return _serialize_user(row)


@router.delete("/admin/api/users/{user_guid}", status_code=204)
def admin_delete_user(user_guid: str, _email: str = Depends(require_admin_session)):
    row = fetch_one("SELECT guid FROM bcf_users WHERE guid = %s", (user_guid,))
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    execute("DELETE FROM bcf_users WHERE guid = %s", (user_guid,))


@router.get("/admin/api/overview")
def admin_overview(_email: str = Depends(require_admin_session)):
    models = fetch_all(
        """
        SELECT m.model_id, m.stream_id, m.server_url, m.commit_id, m.branch_name, m.ingested_at,
               COUNT(t.guid) AS topic_count
        FROM bim_models m
        LEFT JOIN bcf_topics t ON t.model_id = m.model_id
        GROUP BY m.model_id, m.stream_id, m.server_url, m.commit_id, m.branch_name, m.ingested_at
        ORDER BY m.stream_id, m.ingested_at DESC
        """
    )
    servers = fetch_all(
        """
        SELECT s.server_url, s.enabled, s.last_scanned_at, COUNT(w.id) AS watched_streams
        FROM auto_sync_servers s
        LEFT JOIN stream_webhooks w ON w.server_url = s.server_url
        GROUP BY s.server_url, s.enabled, s.last_scanned_at
        ORDER BY s.server_url
        """
    )
    return {
        "models": [
            {
                "model_id": str(r["model_id"]),
                "stream_id": r["stream_id"],
                "server_url": r["server_url"],
                "commit_id": r["commit_id"],
                "branch_name": r["branch_name"],
                "ingested_at": r["ingested_at"].isoformat() if r["ingested_at"] else None,
                "topic_count": r["topic_count"],
            }
            for r in models
        ],
        "servers": [
            {
                "server_url": r["server_url"],
                "enabled": r["enabled"],
                "last_scanned_at": r["last_scanned_at"].isoformat() if r["last_scanned_at"] else None,
                "watched_streams": r["watched_streams"],
            }
            for r in servers
        ],
    }


@router.get("/admin/api/models/{model_id}/topics")
def admin_model_topics(model_id: str, _email: str = Depends(require_admin_session)):
    topics = fetch_all(
        """
        SELECT t.guid, t.title, t.topic_type, t.topic_status, t.priority, t.assigned_to,
               t.creation_author, t.creation_date, COUNT(c.guid) AS comment_count
        FROM bcf_topics t
        LEFT JOIN bcf_comments c ON c.topic_guid = t.guid
        WHERE t.model_id = %s
        GROUP BY t.guid, t.title, t.topic_type, t.topic_status, t.priority, t.assigned_to,
                 t.creation_author, t.creation_date
        ORDER BY t.creation_date DESC
        """,
        (model_id,),
    )
    topic_guids = [str(t["guid"]) for t in topics]
    # Only viewpoints that actually carry a snapshot — this page only ever
    # renders them as thumbnails, no need to surface camera/clipping data here.
    # topic_guid::text = ANY(%s): psycopg2 adapts a Python list of str to a
    # text[] array literal with no type info, and "uuid = ANY(text[])" has no
    # operator in Postgres — cast the column to text instead of the array.
    viewpoints = (
        fetch_all(
            """
            SELECT guid, topic_guid FROM bcf_viewpoints
            WHERE topic_guid::text = ANY(%s) AND snapshot_data IS NOT NULL
            ORDER BY created_at
            """,
            (topic_guids,),
        )
        if topic_guids
        else []
    )
    snapshots_by_topic: dict[str, list[str]] = {}
    for v in viewpoints:
        snapshots_by_topic.setdefault(str(v["topic_guid"]), []).append(str(v["guid"]))
    return [
        {
            "guid": str(t["guid"]),
            "title": t["title"],
            "topic_type": t["topic_type"],
            "topic_status": t["topic_status"],
            "priority": t["priority"],
            "assigned_to": t["assigned_to"],
            "creation_author": t["creation_author"],
            "creation_date": t["creation_date"].isoformat() if t["creation_date"] else None,
            "comment_count": t["comment_count"],
            "snapshot_viewpoint_guids": snapshots_by_topic.get(str(t["guid"]), []),
        }
        for t in topics
    ]


@router.get("/admin/api/viewpoints/{viewpoint_guid}/snapshot")
def admin_viewpoint_snapshot(viewpoint_guid: str, _email: str = Depends(require_admin_session)):
    # Plain <img src> (not fetch()) so the browser attaches the session cookie
    # automatically on this same-origin request — no need to inline base64 or
    # juggle blob URLs in the page's JS, matching how bcf/viewpoints.py's own
    # Bearer-authenticated snapshot endpoint is consumed by real BCF clients.
    row = fetch_one(
        "SELECT snapshot_data, snapshot_format FROM bcf_viewpoints WHERE guid = %s", (viewpoint_guid,)
    )
    if row is None or row["snapshot_data"] is None:
        raise HTTPException(status_code=404, detail="No snapshot for this viewpoint")
    media_type = f"image/{row['snapshot_format'] or 'png'}"
    return Response(content=bytes(row["snapshot_data"]), media_type=media_type)


@router.delete("/admin/api/models/{model_id}")
def admin_purge_model(model_id: str, _email: str = Depends(require_admin_session)):
    row = fetch_one("SELECT stream_id, commit_id FROM bim_models WHERE model_id = %s", (model_id,))
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found")
    deleted = purge_speckle_models(row["stream_id"], commit_id=row["commit_id"])
    return {"deleted": deleted}


@router.delete("/admin/api/streams/{stream_id}")
def admin_purge_stream(stream_id: str, _email: str = Depends(require_admin_session)):
    deleted = purge_speckle_models(stream_id)
    return {"deleted": deleted}
