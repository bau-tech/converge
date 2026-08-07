"""
Recipient resolution + fire-and-forget dispatch for document-workflow
notifications — in-app (bim_notifications) and, if SMTP_HOST is configured,
email. Called via job_registry.fire_and_forget right after each relevant
record_event() call in routers/documents.py, so it runs outside the
request's own connection lifecycle and opens its own.
"""
import base64
import json
import logging
from urllib.parse import quote

from config import settings
from db.connection import get_conn, release_conn
from db.documents import get_document, get_document_author_guid
from db.notifications import create_notification
from db.roles import get_users_with_role
from notifications.email import send_email

logger = logging.getLogger(__name__)

# event_type -> ("role" | "author", roles-to-notify-if-role)
_RECIPIENT_RULES: dict[str, tuple[str, tuple[str, ...]]] = {
    "created": ("role", ("reviewer", "approver")),
    "reviewed": ("role", ("approver",)),
    "approved": ("author", ()),
    "verified": ("author", ()),
    "suitability_set": ("author", ()),
    "revised": ("role", ("reviewer", "approver")),
}

_EVENT_LABEL = {
    "created": "uploaded",
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


def _get_user_by_email(conn, email: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT guid, email, name FROM bcf_users WHERE email = %s", (email,))
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


# Builds a "layout" seed URL identical in shape to the frontend's own
# share-link seed (App.jsx's _urlSeed: {v, projectId, modelName, versionId}),
# base64-encoded the same way App.jsx decodes it (atob() expects *standard*
# base64 — '+/=', not the URL-safe '-_' alphabet — so this must not use
# urlsafe_b64encode). Unlike an actual /share link, nothing is written
# server-side: the whole seed round-trips through the URL itself, so the
# link works even after a restart and doesn't compete for the dashboard's
# tiny 99-slot in-memory share store (routers/dashboard.py). model_id may be
# unresolvable (bcf_topics.model_id is nullable, e.g. a topic imported from a
# .bcfzip that was never matched to an ingested model) — the link still
# opens the right project, just without pre-selecting a model/version.
def _build_topic_link(conn, stream_id: str, model_id: str | None, topic_guid: str) -> str | None:
    if not settings.PUBLIC_APP_URL:
        return None
    seed = {"v": 1, "projectId": stream_id}
    if model_id:
        with conn.cursor() as cur:
            cur.execute("SELECT branch_name, commit_id FROM bim_models WHERE model_id = %s", (model_id,))
            row = cur.fetchone()
        if row and row[0] and row[1]:
            seed["modelName"], seed["versionId"] = row[0], row[1]
    layout = base64.b64encode(json.dumps(seed).encode("utf-8")).decode("ascii")
    return f"{settings.PUBLIC_APP_URL}/?layout={quote(layout, safe='')}&topic={quote(topic_guid, safe='')}"


# Best-effort — a brand-new topic's viewpoint is a separate follow-up POST
# from the frontend (BcfTopicPanel's submitNewTopic creates the topic, then
# createViewpoint() right after), so this fires-and-forgets in a race with
# that second request: assigning at creation time may or may not have a
# snapshot ready yet by the time this runs. Assigning/reassigning an
# *existing* topic (which already has a viewpoint) always finds one.
def _latest_snapshot(conn, topic_guid: str) -> bytes | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT snapshot_data FROM bcf_viewpoints
            WHERE topic_guid = %s AND snapshot_data IS NOT NULL
            ORDER BY created_at DESC LIMIT 1
            """,
            (topic_guid,),
        )
        row = cur.fetchone()
    return bytes(row[0]) if row and row[0] is not None else None


# assigned_to on bcf_topics is free-text (matches openBCF/BIMcollab, which
# don't constrain it either) rather than a bcf_users FK, so the recipient is
# resolved by email here — called from bcf/topics.py right after a topic is
# created or its assigned_to is changed via update. Unlike document events,
# email always fires (best-effort) even for an assignee with no bcf_users
# row — assigned_to is a real address either way, so there's no reason to
# withhold the email just because there's nowhere to put an in-app row.
def notify_bcf_assignment(topic: dict, assigned_to: str, actor: str | None) -> None:
    if not assigned_to:
        return
    conn = get_conn()
    try:
        if actor and actor.strip().lower() == assigned_to.strip().lower():
            return  # don't notify someone about assigning themselves
        actor_label = actor or "Someone"
        title = topic["title"]
        # Short form for the in-app bell (NotificationBell.jsx renders this
        # as a single compact line — no room for the details block below).
        short_message = f'{actor_label} assigned you to "{title}"'

        details = [
            f"Type: {topic.get('topic_type') or '—'}",
            f"Priority: {topic.get('priority') or '—'}",
            f"Due: {topic['due_date'].strftime('%Y-%m-%d') if topic.get('due_date') else '—'}",
        ]
        body_parts = [short_message, "", "\n".join(details)]
        if topic.get("description"):
            body_parts += ["", topic["description"]]
        link = _build_topic_link(conn, topic["stream_id"], topic.get("model_id"), topic["guid"])
        if link:
            body_parts += ["", f"View issue: {link}"]
        email_body = "\n".join(body_parts)

        recipient = _get_user_by_email(conn, assigned_to)
        if recipient is not None:
            create_notification(
                conn, user_guid=recipient["guid"], stream_id=topic["stream_id"], topic_guid=topic["guid"],
                event_type="bcf_assigned", message=short_message,
            )
        snapshot = _latest_snapshot(conn, topic["guid"])
        attachments = [("viewpoint.png", snapshot)] if snapshot else None
        try:
            send_email(assigned_to, "Converge — BCF issue assigned to you", email_body, attachments=attachments)
        except Exception:
            logger.warning("Failed to send BCF assignment email to %s", assigned_to, exc_info=True)
    except Exception:
        logger.warning("notify_bcf_assignment failed for topic %s", topic.get("guid"), exc_info=True)
    finally:
        release_conn(conn)
