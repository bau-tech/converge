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
    if _pool is not None and conn is not None:
        _pool.putconn(conn)


def close_pool() -> None:
    global _pool
    with _lock:
        if _pool is not None:
            _pool.closeall()
            _pool = None
