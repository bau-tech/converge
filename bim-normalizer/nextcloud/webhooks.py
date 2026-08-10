"""
Registers Nextcloud webhook_listeners callbacks so file changes made outside
bim-normalizer's own upload/move/revise/delete calls (a user dragging a file
into Nextcloud's own web UI, an admin editing directly, etc.) get indexed
within minutes instead of only ever being caught by the full-tree fallback
sweep in nextcloud/reconcile.py (main.py's _document_sync_loop, now a daily
safety net rather than the primary mechanism — see its docstring). The
receiving end is routers/nextcloud_webhook.py.

Requires Nextcloud's `allow_local_remote_servers` config enabled: by default
Nextcloud's outgoing HTTP client refuses to call hosts that look like
internal/private addresses (its own SSRF protection), which blocks a
same-Docker-network callback to bim-normalizer's own service name. Confirmed
live against this deployment (LXC 106) — without it, every webhook call
fails with "Host ... violates local access rules" and is only logged, never
retried, so document drift would go silently uncaught.

Delivery latency is bounded by this Nextcloud instance's cron.php cadence
(every 5 minutes via its dedicated `nextcloud-cron` container, confirmed via
its crontab) — background jobs, webhook delivery included, only run when
cron.php executes. So "webhook-driven" here means up to ~5 minutes of
latency per event, not instant — still a large improvement over the
previous 60-minute full-tree poll, and unlike that poll it only does work
for files that actually changed.
"""
import logging

from config import settings
from nextcloud.client import _ocs_request

logger = logging.getLogger(__name__)

CALLBACK_PATH = "/nextcloud-webhook"
HEADER_NAME = "X-Converge-Webhook-Secret"

# Node event classes that matter for document tracking. Nextcloud's Files
# event model has no separate "moved" event — a move is just a
# NodeRenamedEvent whose source/target parents differ — so Renamed alone
# covers both renames and moves.
_EVENTS = (
    "OCP\\Files\\Events\\Node\\NodeCreatedEvent",
    "OCP\\Files\\Events\\Node\\NodeWrittenEvent",
    "OCP\\Files\\Events\\Node\\NodeDeletedEvent",
    "OCP\\Files\\Events\\Node\\NodeRenamedEvent",
)


def _admin_auth() -> tuple[str, str]:
    return (settings.NEXTCLOUD_ADMIN_USER, settings.NEXTCLOUD_ADMIN_PASSWORD)


def _callback_uri() -> str:
    return f"{settings.BIM_NORMALIZER_INTERNAL_URL.rstrip('/')}{CALLBACK_PATH}"


def webhook_secret() -> str:
    """Shared secret Nextcloud sends back in HEADER_NAME on every webhook
    call, verified by routers/nextcloud_webhook.py. Reuses
    DASHBOARD_SESSION_SECRET rather than minting yet another secret env var —
    this app already treats that as its general-purpose app secret (see its
    own fallback-chain comment in config/settings.py)."""
    return settings.DASHBOARD_SESSION_SECRET


def ensure_webhooks_registered() -> None:
    """Idempotent: registers (or re-points, if already registered) one
    webhook per event in _EVENTS, targeting this instance's own callback
    URL/secret. Always re-issues the create/update call rather than
    skip-if-present — a webhook's authData is write-only (never returned by
    the list endpoint, see WebhookListener's own serialization), so there's
    no way to tell "secret unchanged" apart from "secret rotated" without
    just re-sending it every startup. Cheap and safe either way."""
    try:
        existing = {
            w["event"]: w
            for w in _ocs_request("GET", "apps/webhook_listeners/api/v1/webhooks", _admin_auth())
        }
    except Exception as exc:
        logger.warning("Could not list existing Nextcloud webhooks — skipping registration: %s", exc)
        return

    uri = _callback_uri()
    for event in _EVENTS:
        current = existing.get(event)
        payload = {
            "httpMethod": "POST",
            "uri": uri,
            "event": event,
            "eventFilter": {},
            "userIdFilter": None,
            "headers": {},
            "authMethod": "header",
            "authData": {HEADER_NAME: webhook_secret()},
        }
        path = (
            "apps/webhook_listeners/api/v1/webhooks"
            if current is None
            else f"apps/webhook_listeners/api/v1/webhooks/{current['id']}"
        )
        try:
            _ocs_request("POST", path, _admin_auth(), json=payload)
            logger.info("%s Nextcloud webhook for %s -> %s", "Registered" if current is None else "Updated", event, uri)
        except Exception as exc:
            logger.warning("Could not register Nextcloud webhook for %s: %s", event, exc)
