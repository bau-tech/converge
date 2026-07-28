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


def list_commit_ids(server_url: str, token: str, stream_id: str) -> set[str]:
    """Return every commit id currently on stream_id (across all branches —
    this is a stream-level connection, not scoped to one branch), paginating
    past the 100-item page size same as list_streams. Used to detect
    commit_delete/branch_delete events missed while this backend was down:
    get_latest_commit_id alone only catches missed additions, not deletions
    of older commits/branches that were never the "latest" to begin with."""
    query = """
        query($id: String!, $limit: Int!, $cursor: String) {
            stream(id: $id) {
                commits(limit: $limit, cursor: $cursor) {
                    totalCount
                    cursor
                    items { id }
                }
            }
        }
    """
    ids: set[str] = set()
    cursor = None
    while True:
        data = _graphql(server_url, token, query, {"id": stream_id, "limit": 100, "cursor": cursor})
        page = (data.get("stream") or {}).get("commits") or {}
        items = page.get("items") or []
        ids.update(item["id"] for item in items)
        cursor = page.get("cursor")
        if not cursor or len(items) == 0 or len(ids) >= page.get("totalCount", len(ids)):
            break
    return ids


# Speckle is the single source of truth: new versions/models sync in
# (commit_create, branch_create), and every deletion variant Speckle exposes
# is watched too so a deletion there is reflected here instantly instead of
# leaving stale data behind (handled in main.py's receive_speckle_webhook —
# see db.purge.purge_speckle_models). Trigger names are exactly the activity-event
# strings Speckle's webhook dispatcher string-matches against (see
# @speckle/shared's WebhookTriggers / packages/server's StreamActionTypes —
# there's no GraphQL enum for these, the API takes plain strings).
WEBHOOK_TRIGGERS = [
    "commit_create", "branch_create", "stream_delete", "commit_delete", "branch_delete",
]


def register_webhook(server_url: str, token: str, stream_id: str, callback_url: str, secret: str) -> str:
    """Create a Speckle webhook on stream_id pointed at callback_url, firing on
    WEBHOOK_TRIGGERS. Returns the Speckle-assigned webhook id."""
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
            "triggers": WEBHOOK_TRIGGERS,
        }
    }
    data = _graphql(server_url, token, mutation, variables)
    return data["webhookCreate"]


def update_webhook_triggers(server_url: str, token: str, stream_id: str, webhook_id: str) -> None:
    """Re-assert WEBHOOK_TRIGGERS on an already-registered webhook. Called on
    every periodic scan (see scan_server) so streams registered before a
    trigger was added to WEBHOOK_TRIGGERS pick it up automatically, with no
    one-time migration needed — idempotent, cheap to call repeatedly."""
    mutation = """
        mutation($webhook: WebhookUpdateInput!) {
            webhookUpdate(webhook: $webhook)
        }
    """
    variables = {
        "webhook": {
            "id": webhook_id,
            "streamId": stream_id,
            "triggers": WEBHOOK_TRIGGERS,
        }
    }
    _graphql(server_url, token, mutation, variables)


def scan_server(server_url: str, token: str) -> int:
    """
    Ensure every stream on server_url has a registered webhook with the
    current WEBHOOK_TRIGGERS, and drop stream_webhooks rows for streams that
    no longer exist on the server. Streams already registered get their
    triggers re-asserted (cheap, idempotent) rather than being skipped, so
    adding a new trigger to WEBHOOK_TRIGGERS rolls out to every already-
    watched stream on the next scan with no separate migration. Returns the
    number of newly-registered webhooks.

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
    purged = 0

    from db.purge import purge_speckle_models

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id, speckle_webhook_id FROM stream_webhooks WHERE server_url = %s",
                (server_url,),
            )
            known = {row[0]: row[1] for row in cur.fetchall()}

        stale = set(known) - stream_id_set
        if stale:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM stream_webhooks WHERE server_url = %s AND stream_id = ANY(%s)",
                    (server_url, list(stale)),
                )
                removed = cur.rowcount
            conn.commit()

            # A stream missing from list_streams() is gone upstream — same
            # situation as a stream_delete webhook, just discovered late
            # (e.g. the webhook was missed while this backend was down).
            # Purge local data too, not just the watch registration, so
            # reconnecting actually catches up instead of leaving stale
            # models/BCF topics behind indefinitely.
            for stream_id in stale:
                try:
                    deleted = purge_speckle_models(stream_id)
                    if deleted:
                        purged += deleted
                        logger.info(
                            "Reconciliation: stream %s no longer exists on %s — purged %d local model(s)",
                            stream_id, server_url, deleted,
                        )
                except Exception as exc:
                    logger.error(
                        "Reconciliation: failed to purge local data for vanished stream %s on %s: %s",
                        stream_id, server_url, exc, exc_info=True,
                    )

        # Direct check against every model ever ingested from this server —
        # not just streams that previously got a stream_webhooks row. A
        # model can land in bim_models without ever being "known" here (a
        # one-off manual /ingest call, or its stream was already deleted on
        # Speckle before auto-sync was first enabled for this server) — the
        # stream_webhooks-based stale diff above can never catch those,
        # since they were never in `known` to begin with.
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT stream_id FROM bim_models WHERE server_url = %s", (server_url,))
            locally_ingested = {row[0] for row in cur.fetchall()}
        for stream_id in locally_ingested - stream_id_set:
            try:
                deleted = purge_speckle_models(stream_id)
                if deleted:
                    purged += deleted
                    logger.info(
                        "Reconciliation: stream %s (ingested from %s, never webhook-registered) no longer "
                        "exists upstream — purged %d local model(s)",
                        stream_id, server_url, deleted,
                    )
            except Exception as exc:
                logger.error(
                    "Reconciliation: failed to purge never-registered vanished stream %s on %s: %s",
                    stream_id, server_url, exc, exc_info=True,
                )

        for stream_id in stream_ids:
            if stream_id in known:
                webhook_id = known[stream_id]
                if webhook_id:
                    try:
                        update_webhook_triggers(server_url, token, stream_id, webhook_id)
                    except Exception as exc:
                        logger.error(
                            "Failed to refresh webhook triggers for stream %s on %s: %s",
                            stream_id, server_url, exc, exc_info=True,
                        )
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
        import uuid
        from pipeline.normalize import ingest_commit, generate_embeddings_for_model
        from db.jobs import create_job, update_job, find_running_job
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

                # This calls ingest_commit() directly rather than through
                # routers/ingest.py's POST /ingest, so without this guard it
                # never went through that endpoint's dedup either — a manual
                # ingest of the same commit (someone opening the project
                # while this scan is mid-cycle) could run fully concurrently
                # with this one. Confirmed in production: two long-running
                # ingest_commit() calls racing on bim_models' (stream_id,
                # commit_id) unique constraint left the commit fully
                # unpersisted despite both reporting success — a large model
                # takes minutes to ingest, which is plenty of overlap window
                # for this scan (runs on every project load, not just on a
                # timer) to catch mid-flight. Same
                # pg_advisory_xact_lock + find_running_job pattern as
                # routers/ingest.py, and the same bim_jobs row it writes is
                # what that endpoint's own find_running_job() checks — so a
                # manual request arriving during this reconciliation attempt
                # now sees it as in-progress and joins it instead of racing it.
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT pg_advisory_xact_lock(hashtext(%s))",
                        (f"ingest:{stream_id}:{latest_commit_id}",),
                    )
                if find_running_job(conn, "ingest", stream_id=stream_id, commit_id=latest_commit_id):
                    continue  # a manual ingest already has this one — don't duplicate it
                job_id = str(uuid.uuid4())
                create_job(conn, job_id, "ingest", payload={"stream_id": stream_id, "commit_id": latest_commit_id})

                try:
                    ingest_result = ingest_commit(
                        stream_id=stream_id, commit_id=latest_commit_id, token=token, server_url=server_url,
                    )
                except Exception as exc:
                    update_job(conn, job_id, status="failed", error=str(exc))
                    raise
                update_job(conn, job_id, status="complete", result={
                    "model_id": ingest_result["model_id"],
                    "element_count": ingest_result["element_count"],
                    "skipped_count": ingest_result.get("skipped_count"),
                    "skip_geo_count": ingest_result.get("skip_geo_count"),
                    "skip_param_count": ingest_result.get("skip_param_count"),
                })

                # Same reasoning as routers/ingest.py: embeddings are slow
                # CPU-bound inference and shouldn't hold this reconciliation
                # pass up — this whole function already runs off the main
                # event loop (scan_all_enabled_servers wraps it in
                # asyncio.to_thread), so a synchronous call here doesn't
                # block request handling, just this one background thread.
                try:
                    generate_embeddings_for_model(ingest_result["model_id"])
                except Exception as exc:
                    logger.warning("Background embedding generation failed for model %s: %s",
                                    ingest_result["model_id"], exc)

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

        # Deletion reconciliation: the addition-only check above only ever
        # looks at the single latest commit, so a commit_delete/branch_delete
        # missed while this backend was down (deleting something other than
        # the very latest commit) would otherwise never self-heal. Walks
        # every commit id currently on the stream and purges any locally
        # ingested commit_id that's no longer among them — this also
        # inherently covers a deleted branch, since deleting a branch removes
        # all of its commits from this same stream-wide list.
        for stream_id in stream_ids:
            try:
                remote_commit_ids = list_commit_ids(server_url, token, stream_id)
                with conn.cursor() as cur:
                    cur.execute("SELECT commit_id FROM bim_models WHERE stream_id = %s", (stream_id,))
                    local_commit_ids = {row[0] for row in cur.fetchall()}
                for commit_id in local_commit_ids - remote_commit_ids:
                    deleted = purge_speckle_models(stream_id, commit_id=commit_id)
                    if deleted:
                        purged += deleted
                        logger.info(
                            "Reconciliation: commit %s on stream %s no longer exists on %s — purged local model",
                            commit_id, stream_id, server_url,
                        )
            except Exception as exc:
                logger.error(
                    "Deletion-reconciliation failed for stream %s on %s: %s",
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
        "%d stream(s) reconciled, %d model(s) purged via deletion-reconciliation",
        server_url, len(stream_ids), registered, removed, reconciled, purged,
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
