import threading

import psycopg2
from psycopg2 import pool
from config import settings

_pool: pool.SimpleConnectionPool | None = None
_lock = threading.Lock()


def init_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            return
        _pool = pool.ThreadedConnectionPool(
            1, 10,
            host=settings.PG_HOST,
            port=settings.PG_PORT,
            user=settings.PG_USER,
            password=settings.PG_PASS,
            dbname=settings.PG_NAME,
        )


def get_conn():
    if _pool is None:
        init_pool()
    return _pool.getconn()


def release_conn(conn) -> None:
    """Every write function across db/*.py calls conn.commit() itself, and
    every router wraps its own try/finally: release_conn(conn) — but a
    DB-level exception raised mid-transaction (constraint violation,
    deadlock, network blip) inside a try block that doesn't itself catch and
    roll back leaves the connection's transaction aborted when it lands back
    here. Handing that connection straight to the next caller means their
    first query fails with psycopg2's 'current transaction is aborted,
    commands ignored until end of transaction block' — a completely
    unrelated request failing for a cause with no visible link to what
    actually went wrong. Rolling back here, unconditionally, before the
    connection re-enters the pool closes that off structurally instead of
    requiring every one of the ~280 call sites to individually remember
    their own rollback. A no-op (extra round trip aside) for the common case
    where the transaction was already clean or already committed."""
    if _pool is not None and conn is not None:
        try:
            conn.rollback()
        except Exception:
            pass
        _pool.putconn(conn)


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            _pool.closeall()
            _pool = None
