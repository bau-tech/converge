"""
CRUD for bim_notifications — conn-first style matching db/documents.py.
Write side is called from notifications.py's dispatch; read/mark-read side
is used directly by routers/notifications.py.
"""

_COLUMNS = "id, user_guid, stream_id, doc_id, topic_guid, event_type, message, read_at, created_at"


def _row_to_notification(row) -> dict:
    id_, user_guid, stream_id, doc_id, topic_guid, event_type, message, read_at, created_at = row
    return {
        "id": id_,
        "user_guid": str(user_guid),
        "stream_id": stream_id,
        "doc_id": str(doc_id) if doc_id else None,
        "topic_guid": str(topic_guid) if topic_guid else None,
        "event_type": event_type,
        "message": message,
        "read_at": read_at.isoformat() if read_at else None,
        "created_at": created_at.isoformat(),
    }


def create_notification(
    conn, *, user_guid: str, stream_id: str, event_type: str, message: str,
    doc_id: str | None = None, topic_guid: str | None = None,
) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO bim_notifications (user_guid, stream_id, doc_id, topic_guid, event_type, message)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING {_COLUMNS}
                """,
                (user_guid, stream_id, doc_id, topic_guid, event_type, message),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_notification(row)
    except Exception:
        conn.rollback()
        raise


def list_notifications(conn, user_guid: str, unread_only: bool = False, limit: int = 50) -> list[dict]:
    where = ["user_guid = %s"]
    params: list = [user_guid]
    if unread_only:
        where.append("read_at IS NULL")
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM bim_notifications WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT %s",
            (*params, limit),
        )
        rows = cur.fetchall()
    return [_row_to_notification(r) for r in rows]


def unread_count(conn, user_guid: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM bim_notifications WHERE user_guid = %s AND read_at IS NULL", (user_guid,))
        return cur.fetchone()[0]


def mark_read(conn, notification_id: int, user_guid: str) -> dict | None:
    """Scoped to user_guid so a user can't mark someone else's notification
    read by guessing an id."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE bim_notifications SET read_at = NOW()
                WHERE id = %s AND user_guid = %s AND read_at IS NULL
                RETURNING {_COLUMNS}
                """,
                (notification_id, user_guid),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_notification(row) if row else None
    except Exception:
        conn.rollback()
        raise


def mark_all_read(conn, user_guid: str) -> int:
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE bim_notifications SET read_at = NOW() WHERE user_guid = %s AND read_at IS NULL",
                (user_guid,),
            )
            count = cur.rowcount
        conn.commit()
        return count
    except Exception:
        conn.rollback()
        raise
