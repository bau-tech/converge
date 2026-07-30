"""
Document CRUD (bim_documents / bim_document_events) — conn-first style
matching db/jobs.py, shared by routers/documents.py.
"""
import logging

logger = logging.getLogger(__name__)

_COLUMNS = """
    doc_id, stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
    filename, mime_type, size_bytes, etag, status, nc_last_modified,
    approved, approved_by, approved_by_guid, approved_at, revision,
    reviewed, reviewed_by, reviewed_by_guid, reviewed_at,
    verified, verified_by, verified_by_guid, verified_at,
    linked_bcf_topic, linked_element, doc_type, deleted_at, created_at, updated_at
"""


def _row_to_doc(row) -> dict:
    (doc_id, stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
     filename, mime_type, size_bytes, etag, status, nc_last_modified,
     approved, approved_by, approved_by_guid, approved_at, revision,
     reviewed, reviewed_by, reviewed_by_guid, reviewed_at,
     verified, verified_by, verified_by_guid, verified_at,
     linked_bcf_topic, linked_element, doc_type, deleted_at, created_at, updated_at) = row
    return {
        "doc_id": str(doc_id),
        "stream_id": stream_id,
        "model_id": str(model_id) if model_id else None,
        "nc_fileid": nc_fileid,
        "nc_path": nc_path,
        "nc_group_folder": nc_group_folder,
        "filename": filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "etag": etag,
        "status": status,
        "nc_last_modified": nc_last_modified.isoformat() if nc_last_modified else None,
        "approved": approved,
        "approved_by": approved_by,
        "approved_by_guid": str(approved_by_guid) if approved_by_guid else None,
        "approved_at": approved_at.isoformat() if approved_at else None,
        "revision": revision,
        "reviewed": reviewed,
        "reviewed_by": reviewed_by,
        "reviewed_by_guid": str(reviewed_by_guid) if reviewed_by_guid else None,
        "reviewed_at": reviewed_at.isoformat() if reviewed_at else None,
        "verified": verified,
        "verified_by": verified_by,
        "verified_by_guid": str(verified_by_guid) if verified_by_guid else None,
        "verified_at": verified_at.isoformat() if verified_at else None,
        "linked_bcf_topic": str(linked_bcf_topic) if linked_bcf_topic else None,
        "linked_element": linked_element,
        "doc_type": doc_type,
        "deleted_at": deleted_at.isoformat() if deleted_at else None,
        "created_at": created_at.isoformat() if created_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def record_event(conn, doc_id: str, event_type: str, from_value=None, to_value=None, actor=None, actor_guid=None) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO bim_document_events (doc_id, event_type, from_value, to_value, actor, actor_guid)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (doc_id, event_type, from_value, to_value, actor, actor_guid),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def upsert_document(
    conn, *, stream_id: str, model_id: str | None, nc_fileid: int, nc_path: str,
    nc_group_folder: str, filename: str, mime_type: str | None, size_bytes: int | None,
    etag: str | None, status: str, nc_last_modified=None, doc_type: str = "document",
) -> dict:
    """Insert a new document, or update path/metadata for one Nextcloud
    already knows about (matched by (nc_group_folder, nc_fileid), which is
    stable across renames/moves) — used both by the upload route and
    reconcile.py's drift-detector.

    doc_type is intentionally absent from ON CONFLICT DO UPDATE SET:
    reconcile.py calls this with the 'document' default for every file it
    finds, and must never be able to reclassify an existing 'drawing' row
    back to 'document' on a routine rescan — the column is set once, at
    first insert, and left alone on every subsequent upsert."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO bim_documents (
                    stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
                    filename, mime_type, size_bytes, etag, status, nc_last_modified, doc_type
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (nc_group_folder, nc_fileid) DO UPDATE SET
                    nc_path = EXCLUDED.nc_path,
                    filename = EXCLUDED.filename,
                    mime_type = EXCLUDED.mime_type,
                    size_bytes = EXCLUDED.size_bytes,
                    etag = EXCLUDED.etag,
                    status = EXCLUDED.status,
                    nc_last_modified = EXCLUDED.nc_last_modified,
                    deleted_at = NULL,
                    updated_at = NOW()
                RETURNING {_COLUMNS}
                """,
                (stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
                 filename, mime_type, size_bytes, etag, status, nc_last_modified, doc_type),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def list_documents(conn, stream_id: str, status: str | None = None, linked_element: str | None = None) -> list[dict]:
    where = ["stream_id = %s", "deleted_at IS NULL"]
    params: list = [stream_id]
    if status:
        where.append("status = %s")
        params.append(status)
    if linked_element:
        where.append("linked_element = %s")
        params.append(linked_element)
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM bim_documents WHERE {' AND '.join(where)} ORDER BY filename",
            params,
        )
        rows = cur.fetchall()
    return [_row_to_doc(r) for r in rows]


def list_linked_positions(conn, stream_id: str, model_id: str) -> list[dict]:
    """speckle_id + geometry centroid for every element in `model_id` that has
    at least one linked document — used to place viewer pins without pulling
    full document rows. Joined through bim_elements (model-scoped) since
    bim_documents itself is stream-scoped and outlives any one model_id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT be.speckle_id, bg.centroid, COUNT(*) AS doc_count
            FROM bim_documents d
            JOIN bim_elements be ON be.speckle_id = d.linked_element AND be.model_id = %s
            JOIN bim_geometry bg ON bg.element_id = be.element_id
            WHERE d.stream_id = %s AND d.deleted_at IS NULL
              AND d.linked_element IS NOT NULL AND bg.centroid IS NOT NULL
            GROUP BY be.speckle_id, bg.centroid
            """,
            (model_id, stream_id),
        )
        rows = cur.fetchall()
    return [{"speckle_id": r[0], "centroid": r[1], "doc_count": r[2]} for r in rows]


def get_document(conn, doc_id: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_COLUMNS} FROM bim_documents WHERE doc_id = %s", (doc_id,))
        row = cur.fetchone()
    return _row_to_doc(row) if row else None


def update_nc_path(conn, doc_id: str, nc_path: str) -> dict:
    """Rewrites nc_path only (status unchanged) — used when a folder
    containing this document is renamed (routers/documents.py's
    rename_folder), as opposed to set_status()'s status-transition move."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bim_documents SET nc_path = %s, updated_at = NOW() WHERE doc_id = %s RETURNING {_COLUMNS}",
                (nc_path, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def set_status(conn, doc_id: str, status: str, nc_path: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents SET status = %s, nc_path = %s, updated_at = NOW()
                WHERE doc_id = %s RETURNING {_COLUMNS}
                """,
                (status, nc_path, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def set_approved(conn, doc_id: str, actor: str, actor_guid: str | None = None) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET approved = TRUE, approved_by = %s, approved_by_guid = %s, approved_at = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (actor, actor_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def clear_approved(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET approved = FALSE, approved_by = NULL, approved_by_guid = NULL, approved_at = NULL, updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (doc_id,),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def set_reviewed(conn, doc_id: str, actor: str, actor_guid: str | None = None) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET reviewed = TRUE, reviewed_by = %s, reviewed_by_guid = %s, reviewed_at = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (actor, actor_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def clear_reviewed(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET reviewed = FALSE, reviewed_by = NULL, reviewed_by_guid = NULL, reviewed_at = NULL, updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (doc_id,),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def set_verified(conn, doc_id: str, actor: str, actor_guid: str | None = None) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET verified = TRUE, verified_by = %s, verified_by_guid = %s, verified_at = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (actor, actor_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def clear_verified(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET verified = FALSE, verified_by = NULL, verified_by_guid = NULL, verified_at = NULL, updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (doc_id,),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def bump_revision(conn, doc_id: str, *, nc_path: str, size_bytes: int | None, etag: str | None) -> dict:
    """A revised document must re-earn every downstream ISO 19650 gate again —
    increments revision and resets reviewed/approved/verified to false."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET revision = revision + 1, nc_path = %s, size_bytes = %s, etag = %s,
                    reviewed = FALSE, reviewed_by = NULL, reviewed_by_guid = NULL, reviewed_at = NULL,
                    approved = FALSE, approved_by = NULL, approved_by_guid = NULL, approved_at = NULL,
                    verified = FALSE, verified_by = NULL, verified_by_guid = NULL, verified_at = NULL,
                    nc_last_modified = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (nc_path, size_bytes, etag, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def soft_delete_document(conn, doc_id: str) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE bim_documents SET deleted_at = NOW(), updated_at = NOW() WHERE doc_id = %s", (doc_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def link_topic(conn, doc_id: str, topic_guid: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bim_documents SET linked_bcf_topic = %s, updated_at = NOW() WHERE doc_id = %s RETURNING {_COLUMNS}",
                (topic_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def unlink_topic(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bim_documents SET linked_bcf_topic = NULL, updated_at = NOW() WHERE doc_id = %s RETURNING {_COLUMNS}",
                (doc_id,),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def link_element(conn, doc_id: str, speckle_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bim_documents SET linked_element = %s, updated_at = NOW() WHERE doc_id = %s RETURNING {_COLUMNS}",
                (speckle_id, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def unlink_element(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE bim_documents SET linked_element = NULL, updated_at = NOW() WHERE doc_id = %s RETURNING {_COLUMNS}",
                (doc_id,),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def list_events(conn, doc_id: str) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT event_type, from_value, to_value, actor, actor_guid, occurred_at
            FROM bim_document_events WHERE doc_id = %s ORDER BY occurred_at
            """,
            (doc_id,),
        )
        rows = cur.fetchall()
    return [
        {
            "event_type": r[0], "from_value": r[1], "to_value": r[2], "actor": r[3],
            "actor_guid": str(r[4]) if r[4] else None, "occurred_at": r[5].isoformat(),
        }
        for r in rows
    ]
