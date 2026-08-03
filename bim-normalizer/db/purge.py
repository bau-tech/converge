import logging

from db.connection import get_conn, release_conn

logger = logging.getLogger(__name__)


def purge_speckle_models(stream_id: str, *, commit_id: str | None = None, branch_name: str | None = None) -> int:
    """
    Hard-delete local bim_models rows mirroring a deletion that already
    happened on the Speckle server — Speckle is the single source of truth,
    so a stream/branch/commit that no longer exists there shouldn't keep
    living here either. Narrows to a specific commit or branch when given
    (commit_delete/branch_delete webhooks, or a manual admin purge); deletes
    every model for the stream when neither is given (stream_delete).

    bim_elements/geometry/parameters cascade automatically via their FK to
    bim_models (ON DELETE CASCADE). bcf_topics does NOT cascade from that FK
    (it only SETs model_id NULL — that's the right behavior for the manual
    /models/{id} delete endpoint, which shouldn't silently destroy BCF
    discussion history) so it's deleted explicitly here instead, to honor
    "Speckle is the source of truth" for this Speckle-originated deletion
    path specifically.

    For a whole-stream wipe (commit_id and branch_name both None), also
    deletes bim_document_roles and bim_model_status for the stream — neither
    has an FK to bim_models (they're keyed by stream_id/branch_name text
    columns), so they'd otherwise survive forever as stale rows referencing
    a stream that no longer has any models. Deliberately NOT extended to the
    commit/branch-scoped calls: those still leave other commits/branches on
    the same stream alive, which still need their status/roles.

    bim_documents (and the actual Nextcloud files) are NOT touched here —
    that needs live Nextcloud HTTP calls with their own failure handling,
    kept separate in purge_project_documents() below so this stays a fast,
    pure-DB operation on its own. Every whole-stream-wipe caller (webhook
    stream_delete, reconciliation scan, admin_purge_stream) calls both.

    Lives in db/ rather than main.py so bcf-server (a separate process) can
    call it too — via bcf/admin.py's manual purge actions — without pulling
    in main.py's heavier IFC/pandas-dependent module graph.

    Returns the number of bim_models rows deleted.
    """
    where = ["stream_id = %s"]
    params: list = [stream_id]
    if commit_id is not None:
        where.append("commit_id = %s")
        params.append(commit_id)
    if branch_name is not None:
        where.append("branch_name = %s")
        params.append(branch_name)
    where_sql = " AND ".join(where)

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            if commit_id is None and branch_name is None:
                # Whole-stream wipe: also catch any already-orphaned topics
                # (model_id already NULL) that a prior partial cleanup left behind.
                cur.execute("DELETE FROM bcf_topics WHERE stream_id = %s", (stream_id,))
                cur.execute("DELETE FROM bim_document_roles WHERE stream_id = %s", (stream_id,))
                cur.execute("DELETE FROM bim_model_status WHERE stream_id = %s", (stream_id,))
            else:
                cur.execute(
                    f"DELETE FROM bcf_topics WHERE model_id IN (SELECT model_id FROM bim_models WHERE {where_sql})",
                    params,
                )
            cur.execute(f"DELETE FROM bim_models WHERE {where_sql} RETURNING model_id", params)
            deleted = cur.rowcount
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


def purge_project_documents(stream_id: str, actor: str) -> tuple[list[str], bool]:
    """
    Full teardown of a project's Nextcloud footprint: soft-deletes every
    bim_documents row for the stream (deleting the actual file for each one
    too) and tears down the project's Nextcloud group folder plus its
    dedicated group. The Nextcloud-side counterpart to
    purge_speckle_models(stream_id) above — call both together for a real
    "this project is gone" event: the manual admin "delete project" action
    (bcf/admin.py) and, now that a project being deleted on Speckle itself
    means the same thing, the stream_delete webhook and the reconciliation
    scan's vanished-stream cleanup (routers/sync.py, speckle/webhooks.py).

    Every Nextcloud call is best-effort — a failed file/folder delete is
    logged and does not stop the rest of the cleanup or raise, since the
    DB-side purge (which callers still run separately) must not be blocked
    by Nextcloud being unreachable.

    actor: free-text attribution for bim_document_events (e.g. an admin's
    email, or "system (stream_delete webhook)" for automatic callers) — no
    FK, just an audit-trail string.

    Returns (deleted_doc_ids, group_folder_deleted).
    """
    from db.documents import soft_delete_document, record_event
    from nextcloud.client import delete as nc_delete
    from nextcloud.groupfolders import delete_group_folder

    conn = get_conn()
    deleted_doc_ids: list[str] = []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, nc_path FROM bim_documents WHERE stream_id = %s AND deleted_at IS NULL",
                (stream_id,),
            )
            docs = cur.fetchall()

        for doc_id, nc_path in docs:
            try:
                nc_delete(nc_path)
            except Exception as exc:
                logger.warning(
                    "Nextcloud delete failed for doc %s during project teardown (soft-deleting locally anyway): %s",
                    doc_id, exc,
                )
            soft_delete_document(conn, str(doc_id))
            record_event(conn, str(doc_id), "deleted", actor=actor)
            deleted_doc_ids.append(str(doc_id))
    finally:
        release_conn(conn)

    group_folder_deleted = False
    try:
        group_folder_deleted = delete_group_folder(stream_id)
    except Exception as exc:
        logger.warning("Nextcloud group folder teardown failed for stream %s: %s", stream_id, exc)

    return deleted_doc_ids, group_folder_deleted
