"""
Document CRUD (bim_documents / bim_document_events) — conn-first style
matching db/jobs.py, shared by routers/documents.py.
"""
import logging

from psycopg2.extras import Json

from naming.iso19650 import parse_filename

logger = logging.getLogger(__name__)

_COLUMNS = """
    doc_id, stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
    filename, mime_type, size_bytes, etag, status, nc_last_modified,
    approved, approved_by, approved_by_guid, approved_at, revision,
    reviewed, reviewed_by, reviewed_by_guid, reviewed_at,
    verified, verified_by, verified_by_guid, verified_at,
    linked_bcf_topic, linked_element, doc_type,
    naming_compliant, naming_fields,
    suitability_code, suitability_set_by, suitability_set_by_guid, suitability_set_at,
    org_id,
    align_transform, align_elevation_z, align_model_id, align_control_points,
    align_created_by, align_created_by_guid, align_created_at,
    deleted_at, created_at, updated_at
"""


def _row_to_doc(row) -> dict:
    (doc_id, stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
     filename, mime_type, size_bytes, etag, status, nc_last_modified,
     approved, approved_by, approved_by_guid, approved_at, revision,
     reviewed, reviewed_by, reviewed_by_guid, reviewed_at,
     verified, verified_by, verified_by_guid, verified_at,
     linked_bcf_topic, linked_element, doc_type,
     naming_compliant, naming_fields,
     suitability_code, suitability_set_by, suitability_set_by_guid, suitability_set_at,
     org_id,
     align_transform, align_elevation_z, align_model_id, align_control_points,
     align_created_by, align_created_by_guid, align_created_at,
     deleted_at, created_at, updated_at) = row
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
        "naming_compliant": naming_compliant,
        "naming_fields": naming_fields,
        "suitability_code": suitability_code,
        "suitability_set_by": suitability_set_by,
        "suitability_set_by_guid": str(suitability_set_by_guid) if suitability_set_by_guid else None,
        "suitability_set_at": suitability_set_at.isoformat() if suitability_set_at else None,
        "org_id": str(org_id) if org_id else None,
        "align_transform": align_transform,
        "align_elevation_z": align_elevation_z,
        "align_model_id": str(align_model_id) if align_model_id else None,
        "align_control_points": align_control_points,
        "align_created_by": align_created_by,
        "align_created_by_guid": str(align_created_by_guid) if align_created_by_guid else None,
        "align_created_at": align_created_at.isoformat() if align_created_at else None,
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
    org_id: str | None = None,
) -> dict:
    """Insert a new document, or update path/metadata for one Nextcloud
    already knows about (matched by (nc_group_folder, nc_fileid), which is
    stable across renames/moves) — used both by the upload route and
    reconcile.py's drift-detector.

    doc_type and org_id are both intentionally absent from ON CONFLICT DO
    UPDATE SET: reconcile.py calls this with the 'document' default and no
    org context for every file it finds, and must never be able to
    reclassify an existing 'drawing' back to 'document' or blank out an
    org_id set at first upload — both columns are set once, at first
    insert, and left alone on every subsequent upsert.

    naming_compliant/naming_fields are recomputed from filename on every
    call (insert and conflict-update alike) — advisory ISO 19650 naming
    convention check, see naming/iso19650.py."""
    fields = parse_filename(filename)
    naming_compliant = fields is not None
    naming_fields = Json(fields) if fields else None
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO bim_documents (
                    stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
                    filename, mime_type, size_bytes, etag, status, nc_last_modified, doc_type,
                    naming_compliant, naming_fields, org_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (nc_group_folder, nc_fileid) DO UPDATE SET
                    nc_path = EXCLUDED.nc_path,
                    filename = EXCLUDED.filename,
                    mime_type = EXCLUDED.mime_type,
                    size_bytes = EXCLUDED.size_bytes,
                    naming_compliant = EXCLUDED.naming_compliant,
                    naming_fields = EXCLUDED.naming_fields,
                    etag = EXCLUDED.etag,
                    status = EXCLUDED.status,
                    nc_last_modified = EXCLUDED.nc_last_modified,
                    deleted_at = NULL,
                    updated_at = NOW()
                RETURNING {_COLUMNS}
                """,
                (stream_id, model_id, nc_fileid, nc_path, nc_group_folder,
                 filename, mime_type, size_bytes, etag, status, nc_last_modified, doc_type,
                 naming_compliant, naming_fields, org_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def list_documents(
    conn, stream_id: str, status: str | None = None, linked_element: str | None = None,
    viewer_org_id: str | None = None, folder_path: str | None = None,
) -> list[dict]:
    """viewer_org_id enforces ISO 19650 contractual-container separation: a
    WIP document tagged to an org is hidden from viewers in a different org.
    NULL on either side (an unscoped viewer, or a doc that predates/never
    got an org) stays visible — additive/back-compat by design, see
    org_id's schema comment in db/models.py.

    folder_path (None = no folder filter, "" = the folder root, matching
    routers/documents.py's _sanitize_folder_path convention) scopes the
    result to documents whose subfolder is exactly folder_path — mirrors the
    frontend's own docFolderPath() equality check (DocumentsPanel.jsx), so a
    project with many documents spread across subfolders no longer pulls
    every one of them just to render the folder currently being viewed.
    Matched per-status since a document's nc_path prefix depends on which
    status subfolder (01_WIP/02_Shared/...) it currently sits in — a folder
    is one logical thing spanning all 4 status roots (see create_folder),
    not scoped to a single status. Direct children only (not nested
    subfolders): NOT LIKE 'prefix/%/%' excludes anything with another '/'
    after the folder prefix, same as the frontend's exact-match semantics
    (folder navigation is a separate, explicit drill-down, not implied by
    listing a parent)."""
    where = ["stream_id = %s", "deleted_at IS NULL"]
    params: list = [stream_id]
    if status:
        where.append("status = %s")
        params.append(status)
    if linked_element:
        where.append("linked_element = %s")
        params.append(linked_element)
    if folder_path is not None:
        from nextcloud.groupfolders import STATUS_FOLDERS, group_folder_mountpoint
        group_folder = group_folder_mountpoint(stream_id)
        per_status = []
        for doc_status, subfolder in STATUS_FOLDERS.items():
            prefix = f"{group_folder}/{subfolder}/{folder_path}" if folder_path else f"{group_folder}/{subfolder}"
            per_status.append("(status = %s AND nc_path LIKE %s AND nc_path NOT LIKE %s)")
            params.extend([doc_status, f"{prefix}/%", f"{prefix}/%/%"])
        where.append("(" + " OR ".join(per_status) + ")")
    where.append("(status != 'WIP' OR org_id IS NULL OR %s IS NULL OR org_id = %s)")
    params.extend([viewer_org_id, viewer_org_id])
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM bim_documents WHERE {' AND '.join(where)} ORDER BY filename",
            params,
        )
        rows = cur.fetchall()
    return [_row_to_doc(r) for r in rows]


def search_document_content(
    conn, stream_id: str, query: str, viewer_org_id: str | None = None, limit: int = 10,
) -> list[dict]:
    """Rank text chunks (bim_document_chunks, built in the background by
    documents/content_extract.py's index_document — see routers/documents.py's
    upload/revise hooks) across this project's documents by cosine similarity
    to `query`. Same two-query shape as db/query.py's semantic_search_elements,
    same org-scoped WIP visibility as list_documents above (identical WHERE
    clause) — a WIP document's content is exactly as hidden from another
    org as its metadata already is. Returns [] (not an error) when nothing's
    been indexed yet for this project."""
    from search.embeddings import embed_query, cosine_top_k

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.id::text, c.embedding
            FROM bim_document_chunks c
            JOIN bim_documents d ON d.doc_id = c.doc_id
            WHERE d.stream_id = %s AND d.deleted_at IS NULL
              AND (d.status != 'WIP' OR d.org_id IS NULL OR %s IS NULL OR d.org_id = %s)
            """,
            (stream_id, viewer_org_id, viewer_org_id),
        )
        rows = [(r[0], r[1]) for r in cur.fetchall()]
        if not rows:
            return []

        query_vec = embed_query(query)
        ranked = cosine_top_k(query_vec, rows, limit)
        if not ranked:
            return []

        chunk_ids = [cid for cid, _ in ranked]
        cur.execute(
            """
            SELECT c.id::text, c.chunk_text, c.page_num, d.doc_id::text, d.filename, d.status
            FROM bim_document_chunks c
            JOIN bim_documents d ON d.doc_id = c.doc_id
            WHERE c.id = ANY(%s::bigint[])
            """,
            (chunk_ids,),
        )
        by_id = {
            cid: {"chunk_text": text, "page_num": page, "doc_id": doc_id, "filename": filename, "status": status}
            for cid, text, page, doc_id, filename, status in cur.fetchall()
        }

    results = []
    for chunk_id, score in ranked:
        row = by_id.get(chunk_id)
        if row:
            results.append({**row, "score": round(score, 4)})
    return results


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


def set_suitability_code(conn, doc_id: str, code: str, actor: str, actor_guid: str | None = None) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET suitability_code = %s, suitability_set_by = %s, suitability_set_by_guid = %s,
                    suitability_set_at = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (code, actor, actor_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def bump_revision(conn, doc_id: str, *, nc_path: str, size_bytes: int | None, etag: str | None) -> dict:
    """A revised document must re-earn every downstream ISO 19650 gate again —
    increments revision and resets reviewed/approved/verified/suitability_code
    to false/NULL.

    Also evicts any cached thumbnail (bim_document_thumbnails) for this
    file's nc_fileid. This can't be left to the cache's own etag-match check
    to catch: confirmed live against this deployment's Nextcloud that its
    ETag does not reliably change when a file is overwritten in place (two
    uploads of different-length content came back with the identical ETag),
    so an etag comparison alone would keep serving the pre-revision
    thumbnail indefinitely. Deleting here, at the one call site that
    reliably knows content just changed, doesn't depend on ETag behaving
    correctly at all."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents
                SET revision = revision + 1, nc_path = %s, size_bytes = %s, etag = %s,
                    reviewed = FALSE, reviewed_by = NULL, reviewed_by_guid = NULL, reviewed_at = NULL,
                    approved = FALSE, approved_by = NULL, approved_by_guid = NULL, approved_at = NULL,
                    verified = FALSE, verified_by = NULL, verified_by_guid = NULL, verified_at = NULL,
                    suitability_code = NULL, suitability_set_by = NULL,
                    suitability_set_by_guid = NULL, suitability_set_at = NULL,
                    nc_last_modified = NOW(), updated_at = NOW()
                WHERE doc_id = %s
                RETURNING {_COLUMNS}
                """,
                (nc_path, size_bytes, etag, doc_id),
            )
            doc = _row_to_doc(cur.fetchone())
            cur.execute("DELETE FROM bim_document_thumbnails WHERE nc_fileid = %s", (doc["nc_fileid"],))
        conn.commit()
        return doc
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


def set_alignment(
    conn, doc_id: str, transform: dict, elevation_z: float, model_id: str,
    control_points: list, actor: str | None, actor_guid: str | None,
) -> dict:
    """Overwrites any existing alignment — a drawing has at most one active
    alignment at a time (see bim_documents' align_* columns, db/models.py)."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents SET
                    align_transform = %s, align_elevation_z = %s, align_model_id = %s,
                    align_control_points = %s, align_created_by = %s, align_created_by_guid = %s,
                    align_created_at = NOW(), updated_at = NOW()
                WHERE doc_id = %s RETURNING {_COLUMNS}
                """,
                (Json(transform), elevation_z, model_id, Json(control_points), actor, actor_guid, doc_id),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row)
    except Exception:
        conn.rollback()
        raise


def clear_alignment(conn, doc_id: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_documents SET
                    align_transform = NULL, align_elevation_z = NULL, align_model_id = NULL,
                    align_control_points = NULL, align_created_by = NULL, align_created_by_guid = NULL,
                    align_created_at = NULL, updated_at = NOW()
                WHERE doc_id = %s RETURNING {_COLUMNS}
                """,
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


def get_document_author_guid(conn, doc_id: str) -> str | None:
    """Resolves "who uploaded this" from the append-only audit trail rather
    than a redundant created_by column — used by notifications/dispatch.py
    to know who to notify on approved/verified/suitability_set. None if the
    document predates actor_guid attribution (pre-login-era rows, see
    bim_document_events' actor_guid comment in db/models.py)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT actor_guid FROM bim_document_events WHERE doc_id = %s AND event_type = 'created' ORDER BY id LIMIT 1",
            (doc_id,),
        )
        row = cur.fetchone()
    return str(row[0]) if row and row[0] else None


def get_cached_thumbnail(conn, nc_fileid: int, etag: str | None) -> tuple[str, bytes] | None:
    """(content_type, content) if a thumbnail was already rendered for this
    exact file version, else None. etag=None (a document reconciled before
    Nextcloud ever reported one) never matches — always a miss, never a
    false hit — since there's nothing to confirm the cached render is still
    current."""
    if not etag:
        return None
    with conn.cursor() as cur:
        cur.execute(
            "SELECT content_type, content FROM bim_document_thumbnails WHERE nc_fileid = %s AND etag = %s",
            (nc_fileid, etag),
        )
        row = cur.fetchone()
    return (row[0], bytes(row[1])) if row else None


def cache_thumbnail(conn, nc_fileid: int, etag: str, content_type: str, content: bytes) -> None:
    """One row per file (upsert on nc_fileid, not one per etag ever seen) —
    a revision's new etag simply overwrites the prior render rather than
    accumulating stale rows forever."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO bim_document_thumbnails (nc_fileid, etag, content_type, content)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (nc_fileid) DO UPDATE SET
                    etag = EXCLUDED.etag,
                    content_type = EXCLUDED.content_type,
                    content = EXCLUDED.content,
                    created_at = NOW()
                """,
                (nc_fileid, etag, content_type, content),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
