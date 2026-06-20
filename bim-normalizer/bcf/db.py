from db.connection import get_conn, release_conn


def _rows_as_dicts(cur) -> list[dict]:
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_all(sql: str, params: tuple = ()) -> list[dict]:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return _rows_as_dicts(cur)
    finally:
        release_conn(conn)


def fetch_one(sql: str, params: tuple = ()) -> dict | None:
    rows = fetch_all(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple = ()) -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


def execute_returning(sql: str, params: tuple = ()) -> dict | None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = _rows_as_dicts(cur)
        conn.commit()
        return rows[0] if rows else None
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)
