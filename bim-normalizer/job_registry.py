import asyncio
import uuid

# Async job state (ingest/export/IDS-check/clash-check/filter-publish) lives
# in the bim_jobs DB table — see db/jobs.py — not in in-memory dicts here, so
# a backend restart doesn't strand a polling client with an unrecoverable 404.

_background_tasks: set = set()


def fire_and_forget(coro) -> asyncio.Task:
    """asyncio.create_task(), but keeps a strong reference to the resulting
    Task so it can't be garbage-collected mid-flight. The event loop itself
    only holds a weak reference (see the asyncio.create_task docs) — without
    this, a long-running background job (ingest, export, clash/IDS check...)
    can silently vanish after its work finishes but before it records that
    in bim_jobs, leaving a client polling a job stuck at "running" forever
    with no error anywhere."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def _is_uuid(value: str) -> bool:
    """True if value parses as a UUID. Used to reject malformed/missing model
    ids (e.g. a frontend bug sending the literal string "undefined") with a
    clear 400 instead of letting them fall through to an opaque psycopg2
    "invalid input syntax for type uuid" 500."""
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _content_disposition(filename: str, disposition: str = "attachment") -> str:
    """
    Build a Content-Disposition header value that is safe for non-ASCII filenames
    (e.g. German umlauts). Raw non-ASCII bytes in a header value are invalid per
    HTTP and cause browsers to reject the whole response with net::ERR_FAILED
    even though the server returned 200.

    disposition="inline" lets a browser render the response in place (e.g. a
    PDF inside an <iframe>) instead of forcing a download — callers that want
    the existing force-download behavior don't need to change anything.
    """
    from urllib.parse import quote
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "download.ifc"
    # Strip control characters (CR/LF could otherwise inject extra header
    # lines) and escape backslash/quote so a filename containing a literal
    # `"` can't break out of the quoted-string and produce a malformed
    # header (e.g. filename="foo"bar.pdf").
    ascii_name = "".join(c for c in ascii_name if 0x20 <= ord(c) < 0x7F)
    ascii_name = ascii_name.replace("\\", "\\\\").replace('"', '\\"') or "download.ifc"
    return f'{disposition}; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'
