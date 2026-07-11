import uuid

# Async job state (ingest/export/IDS-check/clash-check/filter-publish) lives
# in the bim_jobs DB table — see db/jobs.py — not in in-memory dicts here, so
# a backend restart doesn't strand a polling client with an unrecoverable 404.


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


def _content_disposition(filename: str) -> str:
    """
    Build a Content-Disposition header value that is safe for non-ASCII filenames
    (e.g. German umlauts). Raw non-ASCII bytes in a header value are invalid per
    HTTP and cause browsers to reject the whole response with net::ERR_FAILED
    even though the server returned 200.
    """
    from urllib.parse import quote
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "download.ifc"
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'
