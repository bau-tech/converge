"""
Recipient resolution + fire-and-forget dispatch for document-workflow
notifications — in-app (bim_notifications) and, if SMTP_HOST is configured,
email. Called via job_registry.fire_and_forget right after each relevant
record_event() call in routers/documents.py, so it runs outside the
request's own connection lifecycle and opens its own.
"""
import logging

from db.connection import get_conn, release_conn
from db.documents import get_document, get_document_author_guid
from db.notifications import create_notification
from db.roles import get_users_with_role
from notifications.email import send_email

logger = logging.getLogger(__name__)

# event_type -> ("role" | "author", roles-to-notify-if-role)
_RECIPIENT_RULES: dict[str, tuple[str, tuple[str, ...]]] = {
    "reviewed": ("role", ("approver",)),
    "approved": ("author", ()),
    "verified": ("author", ()),
    "suitability_set": ("author", ()),
    "revised": ("role", ("reviewer", "approver")),
}

_EVENT_LABEL = {
    "moved": "moved to {to_value}",
    "reviewed": "reviewed",
    "approved": "approved",
    "verified": "verified",
    "suitability_set": "given suitability code {to_value}",
    "revised": "revised ({to_value})",
}


def _get_user(conn, guid: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT guid, email, name FROM bcf_users WHERE guid = %s", (guid,))
        row = cur.fetchone()
    return {"guid": str(row[0]), "email": row[1], "name": row[2]} if row else None


def _recipients_for(conn, stream_id: str, doc_id: str, event_type: str, to_value: str | None) -> list[dict]:
    if event_type == "moved":
        # Shared needs reviewer+approver eyes; anything else forward
        # (Published/Archived) or backward is an approver-tier decision —
        # matches move_document's own role gating in routers/documents.py.
        roles = ("reviewer", "approver") if to_value == "Shared" else ("approver",)
        return get_users_with_role(conn, stream_id, roles)

    rule = _RECIPIENT_RULES.get(event_type)
    if rule is None:
        return []
    kind, roles = rule
    if kind == "role":
        return get_users_with_role(conn, stream_id, roles)
    # kind == "author"
    author_guid = get_document_author_guid(conn, doc_id)
    if not author_guid:
        return []
    author = _get_user(conn, author_guid)
    return [author] if author else []


def notify_document_event(stream_id: str, doc_id: str, event_type: str, to_value: str | None, actor_guid: str | None) -> None:
    conn = get_conn()
    try:
        doc = get_document(conn, doc_id)
        if doc is None:
            return
        recipients = _recipients_for(conn, stream_id, doc_id, event_type, to_value)
        if not recipients:
            return
        label = _EVENT_LABEL.get(event_type, event_type).format(to_value=to_value or "")
        message = f'"{doc["filename"]}" was {label}'
        for recipient in recipients:
            if recipient["guid"] == actor_guid:
                continue  # don't notify someone about their own action
            create_notification(
                conn, user_guid=recipient["guid"], stream_id=stream_id, doc_id=doc_id,
                event_type=event_type, message=message,
            )
            try:
                send_email(recipient["email"], "Converge — document update", message)
            except Exception:
                logger.warning("Failed to send notification email to %s", recipient["email"], exc_info=True)
    except Exception:
        logger.warning("notify_document_event failed for doc %s event %s", doc_id, event_type, exc_info=True)
    finally:
        release_conn(conn)
