from db.connection import get_conn, release_conn


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
