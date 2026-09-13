"""
Stdlib SMTP email sender for the notification feed (see dispatch.py). No new
dependency — smtplib/email.mime are in the standard library. No-ops if
SMTP_HOST is unset, so a deployment that hasn't configured SMTP degrades
cleanly to in-app-only notifications rather than failing.
"""
import logging
import smtplib
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from config import settings

logger = logging.getLogger(__name__)


# html_body: optional HTML alternative to the plain-text `body` (mail clients
# that render HTML show this instead; plain-text-only clients fall back to
# `body`). inline_images: [(content_id, filename, raw_bytes), ...] — embedded
# in the HTML via <img src="cid:<content_id>">, not shown as a downloadable
# attachment. Currently just BCF viewpoint snapshots (see
# notifications/dispatch.py's notify_bcf_assignment), always PNG in practice
# (bcf/viewpoints.py hardcodes snapshot_format="png"), but MIMEImage sniffs
# the actual subtype from the bytes rather than assuming.
def send_email(
    to_email: str, subject: str, body: str, *,
    html_body: str | None = None, inline_images: list[tuple[str, str, bytes]] | None = None,
) -> None:
    if not settings.SMTP_HOST:
        logger.debug("SMTP_HOST not configured, skipping email to %s", to_email)
        return
    if html_body or inline_images:
        msg = MIMEMultipart("related")
        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText(body, "plain"))
        if html_body:
            alt.attach(MIMEText(html_body, "html"))
        msg.attach(alt)
        for content_id, filename, data in (inline_images or []):
            img = MIMEImage(data, name=filename)
            img.add_header("Content-ID", f"<{content_id}>")
            img.add_header("Content-Disposition", "inline", filename=filename)
            msg.attach(img)
    else:
        msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = settings.SMTP_FROM or settings.SMTP_USER or "converge@localhost"
    msg["To"] = to_email
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as server:
        if settings.SMTP_USE_TLS:
            server.starttls()
        if settings.SMTP_USER:
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.send_message(msg)
