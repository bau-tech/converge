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


def get_users_with_role(conn, stream_id: str, roles: tuple[str, ...]) -> list[dict]:
    """Mirror image of get_user_roles() — everyone holding any of `roles` on
    a project, for notification recipient resolution (notifications.py).
    Same stream_id='*' union as get_user_roles(). DISTINCT because a user
    holding e.g. both 'reviewer' and 'approver' would otherwise appear once
    per matching role row."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT u.guid, u.email, u.name
            FROM bim_document_roles r
            JOIN bcf_users u ON u.guid = r.user_guid
            WHERE r.stream_id IN (%s, '*') AND r.role = ANY(%s)
            """,
            (stream_id, list(roles)),
        )
        return [{"guid": str(g), "email": e, "name": n} for g, e, n in cur.fetchall()]
