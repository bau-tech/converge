import asyncio
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from db.jobs import create_job, update_job, find_running_job, prune_jobs
from job_registry import fire_and_forget
from process_pool import run_cpu_bound

router = APIRouter(tags=["sync"])
logger = logging.getLogger(__name__)


@router.get("/servers")
def list_servers():
    """
    Return all configured Speckle servers (name, url, token) so the dashboard
    can let users switch between them.  Tokens are returned because the
    Speckle viewer SDK needs them client-side; restrict network access
    appropriately rather than trying to hide them here.
    """
    import os
    servers = []

    primary_url   = os.getenv("SPECKLE_SERVER_URL", "").rstrip("/")
    primary_token = os.getenv("SPECKLE_TOKEN", "")
    if primary_url:
        servers.append({"id": "default", "name": "Default", "url": primary_url, "token": primary_token})

    extra = (os.getenv("EXTRA_SPECKLE_SERVERS") or "").strip()
    for i, entry in enumerate(extra.split(",") if extra else []):
        parts = [p.strip() for p in entry.split("|")]
        if len(parts) >= 2 and parts[1]:
            servers.append({
                "id":    f"server_{i}",
                "name":  parts[0] or f"Server {i + 1}",
                "url":   parts[1].rstrip("/"),
                "token": parts[2] if len(parts) >= 3 else "",
            })

    return servers


# ---------------------------------------------------------------------------
# Webhook auto-sync
# ---------------------------------------------------------------------------
# Backend-owned watch list of Speckle servers: when enabled, every stream on
# that server gets a Speckle webhook registered (speckle/webhooks.py), so new
# versions/models sync in without anyone having the dashboard open. This is
# genuinely new persistent state — unlike /servers above, which just reflects
# env config, /auto-sync/servers stores credentials in our own DB because a
# webhook delivery has no user session to borrow a token from.

class AutoSyncServerBody(BaseModel):
    server_url: str
    token: str
    enabled: bool = True


@router.get("/auto-sync/servers")
def list_auto_sync_servers():
    """Watched servers plus how many of their streams already have a webhook registered."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.server_url, s.enabled, s.last_scanned_at,
                       COUNT(w.id) AS watched_streams
                FROM auto_sync_servers s
                LEFT JOIN stream_webhooks w ON w.server_url = s.server_url
                GROUP BY s.server_url, s.enabled, s.last_scanned_at
                ORDER BY s.server_url
            """)
            rows = cur.fetchall()
    finally:
        release_conn(conn)

    return [
        {
            "server_url": r[0],
            "enabled": r[1],
            "last_scanned_at": r[2].isoformat() if r[2] else None,
            "watched_streams": r[3],
        }
        for r in rows
    ]


@router.post("/auto-sync/servers")
async def upsert_auto_sync_server(body: AutoSyncServerBody):
    """Enable/disable auto-sync for a server. Enabling immediately triggers
    one scan rather than waiting for the periodic background pass."""
    from config import settings
    from db.connection import get_conn, release_conn
    from speckle.webhooks import scan_server

    if body.enabled and not settings.PUBLIC_BASE_URL:
        # Check before writing — otherwise a failed request still leaves a
        # misleading enabled=true row with zero registered webhooks.
        raise HTTPException(
            status_code=400,
            detail="PUBLIC_BASE_URL is not configured on the backend — auto-sync cannot register webhooks",
        )

    server_url = body.server_url.rstrip("/")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO auto_sync_servers (server_url, token, enabled)
                VALUES (%s, %s, %s)
                ON CONFLICT (server_url) DO UPDATE
                    SET token = EXCLUDED.token, enabled = EXCLUDED.enabled
            """, (server_url, body.token, body.enabled))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)

    if body.enabled:
        fire_and_forget(asyncio.to_thread(scan_server, server_url, body.token))

    return {"status": "ok"}


@router.post("/auto-sync/scan")
async def trigger_auto_sync_scan():
    """
    Fire an on-demand auto-sync scan of every enabled server, same logic as
    the periodic background loop in main.py's _auto_sync_loop. The frontend
    calls this once on app load so a brand-new project gets its webhook
    registered immediately, instead of waiting for the next background pass.
    Fire-and-forget: returns right away rather than blocking page load on a
    multi-server GraphQL scan.
    """
    from speckle.webhooks import scan_all_enabled_servers

    fire_and_forget(scan_all_enabled_servers())
    return {"status": "scan_started"}


@router.post("/webhooks/speckle/{webhook_row_id}")
async def receive_speckle_webhook(webhook_row_id: str, request: Request):
    """
    Speckle calls this when a watched stream gets a new commit or branch.
    webhook_row_id maps back to (server_url, token, secret) via stream_webhooks
    — routing never trusts payload content, only this path segment, since the
    payload's own shape/fields vary across Speckle server versions.
    """
    import hashlib
    import hmac
    import json

    from db.connection import get_conn, release_conn
    from db.purge import purge_speckle_models
    from pipeline.normalize import ingest_commit

    raw_body = await request.body()

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT server_url, stream_id, secret FROM stream_webhooks WHERE id = %s",
                (webhook_row_id,),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)

    if not row:
        raise HTTPException(status_code=404, detail="Unknown webhook")
    server_url, stream_id, secret = row

    signature = request.headers.get("X-WEBHOOK-SIGNATURE", "")
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        logger.warning("Webhook %s: signature mismatch — rejecting", webhook_row_id)
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        payload = json.loads(raw_body)
    except Exception:
        logger.error("Webhook %s: body is not valid JSON", webhook_row_id)
        raise HTTPException(status_code=400, detail="Invalid payload")

    event = payload.get("event") or {}
    event_name = event.get("event_name") or payload.get("event_name") or ""
    event_data = event.get("data") or {}
    commit_id = event_data.get("id")

    logger.info("Webhook %s: received %r for stream %s (commit_id=%r)",
                webhook_row_id, event_name, stream_id, commit_id)

    if event_name == "stream_delete":
        # The stream itself is gone — drop our watch registration AND every
        # local model/BCF-topic ingested from it. Speckle is the single
        # source of truth, so a project deleted there shouldn't keep living
        # in the dashboard/BCF server. The periodic scan's reconciliation
        # pass (speckle/webhooks.scan_server) is the fallback for streams
        # registered before this trigger existed.
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM stream_webhooks WHERE id = %s", (webhook_row_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            release_conn(conn)
        models_deleted = purge_speckle_models(stream_id)
        logger.info(
            "Webhook %s: stream %s deleted upstream — removed local registration and %d local model(s)",
            webhook_row_id, stream_id, models_deleted,
        )
        return {"status": "removed", "models_deleted": models_deleted}

    if event_name == "commit_delete":
        deleted_commit_id = event_data.get("id") or (event_data.get("commit") or {}).get("id")
        if not deleted_commit_id:
            logger.warning("Webhook %s: commit_delete with no resolvable commit id — data=%r", webhook_row_id, event_data)
            return {"status": "ignored", "event_name": event_name}
        models_deleted = purge_speckle_models(stream_id, commit_id=deleted_commit_id)
        logger.info(
            "Webhook %s: commit %s deleted upstream on stream %s — removed %d local model(s)",
            webhook_row_id, deleted_commit_id, stream_id, models_deleted,
        )
        return {"status": "removed", "models_deleted": models_deleted}

    if event_name == "branch_delete":
        deleted_branch_name = (event_data.get("branch") or {}).get("name")
        if not deleted_branch_name:
            logger.warning("Webhook %s: branch_delete with no resolvable branch name — data=%r", webhook_row_id, event_data)
            return {"status": "ignored", "event_name": event_name}
        models_deleted = purge_speckle_models(stream_id, branch_name=deleted_branch_name)
        logger.info(
            "Webhook %s: branch %r deleted upstream on stream %s — removed %d local model(s)",
            webhook_row_id, deleted_branch_name, stream_id, models_deleted,
        )
        return {"status": "removed", "models_deleted": models_deleted}

    if event_name != "commit_create" or not commit_id:
        # branch_create has nothing to ingest yet — the new branch's first
        # commit_create event (which we're also subscribed to) is what
        # actually triggers a sync.
        return {"status": "ignored", "event_name": event_name}

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT token FROM auto_sync_servers WHERE server_url = %s", (server_url,))
            token_row = cur.fetchone()
    finally:
        release_conn(conn)
    if not token_row:
        logger.error("Webhook %s: no auto_sync_servers token for %s", webhook_row_id, server_url)
        raise HTTPException(status_code=500, detail="Server credentials not found")
    token = token_row[0]

    job_conn = get_conn()
    try:
        # Same check-then-act race as routers/ingest.py's /ingest endpoint —
        # Speckle retries a webhook delivery on timeout, so two near-
        # simultaneous deliveries for the same commit can both pass this
        # check before either commits its create_job() insert. Serialize
        # per stream_id+commit_id; the lock auto-releases at create_job()'s
        # commit below.
        with job_conn.cursor() as cur:
            cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s))",
                (f"ingest:{stream_id}:{commit_id}",),
            )
        running_job_id = find_running_job(job_conn, "ingest", stream_id=stream_id, commit_id=commit_id)
        if running_job_id:
            return {"job_id": running_job_id, "status": "pending"}

        job_id = str(uuid.uuid4())
        create_job(job_conn, job_id, "ingest", payload={"stream_id": stream_id, "commit_id": commit_id})
    finally:
        release_conn(job_conn)

    async def _run():
        conn2 = get_conn()
        try:
            result = await run_cpu_bound(
                ingest_commit, stream_id=stream_id, commit_id=commit_id,
                token=token, server_url=server_url,
            )
            update_job(conn2, job_id, status="complete", result={
                "model_id": result["model_id"],
                "element_count": result["element_count"],
                "skipped_count": result.get("skipped_count"),
                "skip_geo_count": result.get("skip_geo_count"),
                "skip_param_count": result.get("skip_param_count"),
            })
        except Exception as exc:
            logger.error("Webhook ingest error (job %s): %s", job_id, exc, exc_info=True)
            update_job(conn2, job_id, status="failed", error=str(exc))
        finally:
            try:
                prune_jobs(conn2, "ingest")
            finally:
                release_conn(conn2)

    fire_and_forget(_run())
    logger.info("Webhook %s: started ingest job %s for commit %s", webhook_row_id, job_id, commit_id)
    return {"job_id": job_id, "status": "pending"}
