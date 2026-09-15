"""
ISO 19650 per-project document-workflow roles (bim_document_roles) — conn-first
style matching db/documents.py. Role grants themselves are managed from
bcf-server's admin panel (bcf/admin.py, via bcf.db's fetch/execute helpers,
since that's the only authenticated admin surface in this app); this module
is the read side used by bim-normalizer's own request path (dashboard_auth's
require_role dependency, and the /my-roles endpoint).
"""


def get_user_roles(conn, user_guid: str, stream_id: str) -> set[str]:
    """A row with stream_id = '*' is a blanket "all projects" grant (see
    bim_document_roles' schema comment) — always unioned in alongside any
    project-specific grant."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT role FROM bim_document_roles WHERE user_guid = %s AND stream_id IN (%s, '*')",
            (user_guid, stream_id),
        )
        return {row[0] for row in cur.fetchall()}


def is_user_restricted(conn, user_guid: str) -> bool:
    """A hard, role-independent lockout (bcf_users.is_restricted) — checked
    ahead of the normal role intersection in require_project_role, so a
    restricted account is denied every document/model mutation regardless
    of whatever bim_document_roles grants exist for it. See db_schema.py's
    column comment for why this exists as a separate flag rather than just
    withholding role grants."""
    with conn.cursor() as cur:
        cur.execute("SELECT is_restricted FROM bcf_users WHERE guid = %s", (user_guid,))
        row = cur.fetchone()
    return bool(row and row[0])


def get_user_accessible_streams(conn, user_guid: str) -> dict:
    """Every stream_id this user holds ANY role on — for gating which
    projects the dashboard's project switcher shows, as opposed to
    get_user_roles's single-stream check used by require_project_role. A
    '*' grant means blanket access to every project on the server (same
    semantics require_project_role already gives '*' when checking one
    specific stream_id), reported here as `all: True` rather than an
    enumerable list."""
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT stream_id FROM bim_document_roles WHERE user_guid = %s", (user_guid,))
        stream_ids = {row[0] for row in cur.fetchall()}
    if "*" in stream_ids:
        return {"all": True, "stream_ids": []}
    return {"all": False, "stream_ids": sorted(stream_ids)}


def get_users_with_role(conn, stream_id: str, roles: tuple[str, ...]) -> list[dict]:
    """Mirror image of get_user_roles() — everyone holding any of `roles` on
    a project, for notification recipient resolution (notifications.py).
    Same stream_id='*' union as get_user_roles(). DISTINCT because a user
    holding e.g. both 'reviewer' and 'approver' would otherwise appear once
    per matching role row."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT u.guid, u.email, u.name, u.notify_email
            FROM bim_document_roles r
            JOIN bcf_users u ON u.guid = r.user_guid
            WHERE r.stream_id IN (%s, '*') AND r.role = ANY(%s)
            """,
            (stream_id, list(roles)),
        )
        return [{"guid": str(g), "email": e, "name": n, "notify_email": ne} for g, e, n, ne in cur.fetchall()]
