import logging

from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["models"])
logger = logging.getLogger(__name__)


@router.get("/models")
def list_models():
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id, m.stream_id, m.commit_id, m.branch_name,
                       m.source, m.author, m.message, m.ingested_at,
                       COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                GROUP BY m.model_id
                ORDER BY m.ingested_at DESC
            """)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@router.get("/models/{model_id}")
def get_model(model_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.*, COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.model_id = %s
                GROUP BY m.model_id
            """, (model_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            cols = [d[0] for d in cur.description]
        return dict(zip(cols, row))
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}")
def delete_model(model_id: str):
    """
    Delete a model and all its associated elements, geometry, and parameters.
    After deletion the next /ingest for the same commit will re-classify from scratch.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT model_id FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            # Cascade deletes handle elements → geometry + parameters via FK
            cur.execute("DELETE FROM bim_models WHERE model_id = %s", (model_id,))
        conn.commit()
        logger.info("Deleted model %s", model_id)
        return {"deleted": model_id}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.get("/models/trend/{stream_id}")
def get_model_trend(stream_id: str):
    """
    Version history trend for a stream.
    Returns [{model_id, commit_id, branch_name, ingested_at, source, message,
              total_elements, by_category: {cat: count}}]
    ordered oldest → newest.  Used to plot element-count evolution over time.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_trend as _trend
    conn = get_conn()
    try:
        return _trend(conn, stream_id)
    finally:
        release_conn(conn)
