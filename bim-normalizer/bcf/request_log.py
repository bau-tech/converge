"""
In-memory ring buffer of recent HTTP requests, surfaced in the admin panel
so diagnosing what a connecting BCF client actually did doesn't require
SSH-ing into the host and grepping `docker logs`.
"""
import time
from collections import deque

_MAX_ENTRIES = 200
_entries: deque[dict] = deque(maxlen=_MAX_ENTRIES)


def record(method: str, path: str, status_code: int, client_ip: str | None, duration_ms: float) -> None:
    # appendleft + a maxlen deque means recent() can return newest-first
    # without ever needing to reverse or re-sort.
    _entries.appendleft(
        {
            "time": time.time(),
            "method": method,
            "path": path,
            "status": status_code,
            "client_ip": client_ip or "",
            "duration_ms": round(duration_ms, 1),
        }
    )


def recent(limit: int = 100) -> list[dict]:
    return list(_entries)[:limit]
