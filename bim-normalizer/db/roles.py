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
