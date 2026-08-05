"""
Stdlib SMTP email sender for the notification feed (see dispatch.py). No new
dependency — smtplib/email.mime are in the standard library. No-ops if
SMTP_HOST is unset, so a deployment that hasn't configured SMTP degrades
cleanly to in-app-only notifications rather than failing.
"""
import logging
import smtplib
from email.mime.text import MIMEText

from config import settings

logger = logging.getLogger(__name__)


def send_email(to_email: str, subject: str, body: str) -> None:
    if not settings.SMTP_HOST:
        logger.debug("SMTP_HOST not configured, skipping email to %s", to_email)
        return
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
