"""
Speckle webhook registration for backend-driven auto-sync — distinct from
speckle/fetch.py (which fetches commit data given an id a *user* already
has). Here the backend itself is the one discovering which streams exist and
asking the Speckle server to notify it of new commits/branches, so a model
re-syncs even with nobody's browser open. Same requests.post(f"{srv}/graphql",
...) convention as fetch.py, including its try/except fallback style for
schema fields whose presence/shape can vary across Speckle server versions.
"""
import logging
import secrets

import requests

from config import settings
from db.connection import get_conn, release_conn

logger = logging.getLogger(__name__)


def _graphql(server_url: str, token: str, query: str, variables: dict) -> dict:
    resp = requests.post(
        f"{server_url}/graphql",
        json={"query": query, "variables": variables},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")
    return body["data"]


def list_streams(server_url: str, token: str) -> list[str]:
    """Return every stream id visible to this token, paginating past the
    100-item page size used elsewhere in this app (App.jsx's loadProjects)."""
    query = """
        query($limit: Int!, $cursor: String) {
            streams(limit: $limit, cursor: $cursor) {
                totalCount
                cursor
                items { id }
            }
        }
    """
    ids: list[str] = []
    cursor = None
    while True:
        data = _graphql(server_url, token, query, {"limit": 100, "cursor": cursor})
        page = data["streams"]
        ids.extend(item["id"] for item in page["items"])
        cursor = page.get("cursor")
        if not cursor or len(page["items"]) == 0 or len(ids) >= page.get("totalCount", len(ids)):
            break
    return ids


def get_latest_commit_id(server_url: str, token: str, stream_id: str) -> str | None:
    """Return the most recent commit id on stream_id, or None if it has no commits yet."""
    query = """
        query($id: String!) {
            stream(id: $id) {
                commits(limit: 1) {
                    items { id }
                }
            }
        }
    """
    data = _graphql(server_url, token, query, {"id": stream_id})
    items = ((data.get("stream") or {}).get("commits") or {}).get("items") or []
    return items[0]["id"] if items else None


def register_webhook(server_url: str, token: str, stream_id: str, callback_url: str, secret: str) -> str:
    """Create a Speckle webhook on stream_id pointed at callback_url, firing on
    new versions (commit_create), new models (branch_create), and the stream's
    own deletion (stream_delete — lets the receiver clean up its
    stream_webhooks row immediately rather than waiting on the periodic
    scan's reconciliation pass). Returns the Speckle-assigned webhook id."""
    mutation = """
        mutation($webhook: WebhookCreateInput!) {
            webhookCreate(webhook: $webhook)
        }
    """
    variables = {
        "webhook": {
            "streamId": stream_id,
            "url": callback_url,
            "secret": secret,
            "enabled": True,
            "triggers": ["commit_create", "branch_create", "stream_delete"],
        }
    }
    data = _graphql(server_url, token, mutation, variables)
    return data["webhookCreate"]


def scan_server(server_url: str, token: str) -> int:
    """
    Ensure every stream on server_url has a registered webhook, and drop
    stream_webhooks rows for streams that no longer exist on the server.
    Idempotent — streams already present in stream_webhooks are skipped
    without calling Speckle again. Returns the number of newly-registered
    webhooks.

    The deletion side is a safety net, not the primary mechanism: a deleted
    stream's webhook also fires stream_delete (handled instantly by the
    receiver), but this catches cases where that event doesn't arrive — e.g.
    streams registered before stream_delete was added to the trigger list.

    Requires PUBLIC_BASE_URL to be configured; without a publicly reachable
    callback URL there is nothing useful to register.
    """
    if not settings.PUBLIC_BASE_URL:
        logger.warning("PUBLIC_BASE_URL is not configured — skipping webhook scan for %s", server_url)
        return 0

    stream_ids = list_streams(server_url, token)
    stream_id_set = set(stream_ids)
    registered = 0
    removed = 0

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id FROM stream_webhooks WHERE server_url = %s",
                (server_url,),
            )
            known = {row[0] for row in cur.fetchall()}

        stale = known - stream_id_set
        if stale:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM stream_webhooks WHERE server_url = %s AND stream_id = ANY(%s)",
                    (server_url, list(stale)),
                )
                removed = cur.rowcount
            conn.commit()

        for stream_id in stream_ids:
            if stream_id in known:
                continue
            secret = secrets.token_hex(32)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO stream_webhooks (server_url, stream_id, secret)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (server_url, stream_id) DO NOTHING
                        RETURNING id
                        """,
                        (server_url, stream_id, secret),
                    )
                    row = cur.fetchone()
                conn.commit()
                if not row:
                    continue  # lost a race with another scan — already inserted
                webhook_row_id = str(row[0])

                callback_url = f"{settings.PUBLIC_BASE_URL}/webhooks/speckle/{webhook_row_id}"
                speckle_webhook_id = register_webhook(server_url, token, stream_id, callback_url, secret)

                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE stream_webhooks SET speckle_webhook_id = %s WHERE id = %s",
                        (speckle_webhook_id, webhook_row_id),
                    )
                conn.commit()
                registered += 1
            except Exception as exc:
                conn.rollback()
                logger.error(
                    "Failed to register webhook for stream %s on %s: %s",
                    stream_id, server_url, exc, exc_info=True,
                )

        # Catch-up reconciliation: a missed webhook delivery (downtime, a
        # transient error) would otherwise leave a stream silently stale
        # forever, since the only other path to ingestion is someone
        # manually opening that project in the dashboard. Cheap to check —
        # one GraphQL call per stream — and runs for every watched stream,
        # not just ones registered this pass.
        reconciled = 0
        from pipeline.normalize import ingest_commit
        for stream_id in stream_ids:
            try:
                latest_commit_id = get_latest_commit_id(server_url, token, stream_id)
                if not latest_commit_id:
                    continue
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT commit_id FROM bim_models WHERE stream_id = %s ORDER BY ingested_at DESC LIMIT 1",
                        (stream_id,),
                    )
                    row = cur.fetchone()
                ingested_commit_id = row[0] if row else None
                if ingested_commit_id == latest_commit_id:
                    continue
                ingest_commit(stream_id=stream_id, commit_id=latest_commit_id, token=token, server_url=server_url)
                reconciled += 1
                logger.info(
                    "Reconciled stream %s on %s: ingested missed commit %s",
                    stream_id, server_url, latest_commit_id,
                )
            except Exception as exc:
                logger.error(
                    "Reconciliation failed for stream %s on %s: %s",
                    stream_id, server_url, exc, exc_info=True,
                )

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE auto_sync_servers SET last_scanned_at = NOW() WHERE server_url = %s",
                (server_url,),
            )
        conn.commit()
    finally:
        release_conn(conn)

    logger.info(
        "Scanned %s: %d stream(s) total, %d new webhook(s) registered, %d stale entry(ies) removed, "
        "%d stream(s) reconciled",
        server_url, len(stream_ids), registered, removed, reconciled,
    )
    return registered


async def scan_all_enabled_servers() -> None:
    """Iterate every enabled row in auto_sync_servers and scan it. Run in a
    background thread per server since scan_server does blocking DB + HTTP work."""
    import asyncio

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT server_url, token FROM auto_sync_servers WHERE enabled")
            rows = cur.fetchall()
    finally:
        release_conn(conn)

    for server_url, token in rows:
        try:
            await asyncio.to_thread(scan_server, server_url, token)
        except Exception as exc:
            logger.error("Auto-sync scan failed for %s: %s", server_url, exc, exc_info=True)
