"""
Per-branch WIP/Shared/Published/Archived status (bim_model_status) — mirrors
db/documents.py's status handling but for whole Speckle models (branches)
rather than individual files.
"""
import logging

logger = logging.getLogger(__name__)


def _row_to_status(row) -> dict:
    stream_id, branch_name, status, updated_at = row
    return {
        "stream_id": stream_id,
        "branch_name": branch_name,
        "status": status,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def list_statuses(conn, stream_id: str) -> dict[str, str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT branch_name, status FROM bim_model_status WHERE stream_id = %s",
            (stream_id,),
        )
        rows = cur.fetchall()
    return {branch_name: status for branch_name, status in rows}


def set_status(conn, stream_id: str, branch_name: str, status: str) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO bim_model_status (stream_id, branch_name, status)
                VALUES (%s, %s, %s)
                ON CONFLICT (stream_id, branch_name) DO UPDATE SET
                    status = EXCLUDED.status, updated_at = NOW()
                RETURNING stream_id, branch_name, status, updated_at
                """,
                (stream_id, branch_name, status),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_status(row)
    except Exception:
        conn.rollback()
        raise


def delete_status(conn, stream_id: str, branch_name: str) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bim_model_status WHERE stream_id = %s AND branch_name = %s",
                (stream_id, branch_name),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
