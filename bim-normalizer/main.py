import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# In-memory job registry for async ingest jobs.
# Keyed by job_id; each entry: {status, stream_id, commit_id, model_id, error, element_count}
_ingest_jobs: Dict[str, Dict[str, Any]] = {}

# In-memory job registry for async IFC export jobs.
# Keyed by job_id; each entry: {status, ifc_bytes, filename, error}
_export_jobs: Dict[str, Dict[str, Any]] = {}

# In-memory job registry for filter-publish jobs.
# Keyed by job_id; each entry: {status, result, error}
_filter_publish_jobs: Dict[str, Dict[str, Any]] = {}

# In-memory job registry for IDS check jobs.
# Keyed by job_id; each entry: {status, result, error}
_ids_check_jobs: Dict[str, Dict[str, Any]] = {}

# In-memory job registry for clash detection jobs.
# Keyed by job_id; each entry: {status, result, error}
_clash_check_jobs: Dict[str, Dict[str, Any]] = {}

# Dashboard share-link store. Rolling slots share01–share99 (wraps, overwrites oldest).
# Data is lost on restart — share links are short-lived convenience URLs.
_dashboard_shares: Dict[str, Any] = {}
_share_counter = 0

_JOB_KEEP = 100  # max completed/failed entries to retain per registry


def _prune_jobs(registry: Dict[str, Dict[str, Any]]) -> None:
    done = [jid for jid, j in registry.items() if j.get("status") in ("complete", "failed")]
    for jid in done[:-_JOB_KEEP]:
        del registry[jid]


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
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "download.ifc"
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


_STREAM_COMMIT_LIMIT = 10  # max ingested versions kept per Speckle stream


def _prune_stream_commits(stream_id: str) -> int:
    """
    Delete all but the _STREAM_COMMIT_LIMIT most recent bim_models rows for
    stream_id.  ON DELETE CASCADE removes all child rows automatically.
    Returns the number of models deleted.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM bim_models
                WHERE stream_id = %s
                  AND model_id NOT IN (
                      SELECT model_id FROM bim_models
                      WHERE stream_id = %s
                      ORDER BY ingested_at DESC
                      LIMIT %s
                  )
                RETURNING model_id
            """, (stream_id, stream_id, _STREAM_COMMIT_LIMIT))
            deleted = cur.rowcount
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)

from db.connection import init_pool, close_pool
from db.models import init_schema

import os as _os
_log_level = getattr(logging, (_os.getenv("LOG_LEVEL") or "INFO").upper(), logging.INFO)
logging.basicConfig(
    level=_log_level,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


async def _auto_sync_loop():
    from config import settings
    from speckle.webhooks import scan_all_enabled_servers
    while True:
        # Scan immediately on every iteration, including the first — catches
        # up on anything missed (new streams, missed deletions) while this
        # backend was down, rather than waiting a full interval after restart.
        try:
            await scan_all_enabled_servers()
        except Exception as exc:
            logger.error("Auto-sync scan failed: %s", exc, exc_info=True)
        await asyncio.sleep(settings.AUTO_SYNC_SCAN_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting bim-normalizer...")
    init_pool()
    init_schema()
    logger.info("DB schema ready.")
    auto_sync_task = asyncio.create_task(_auto_sync_loop())
    yield
    auto_sync_task.cancel()
    close_pool()
    logger.info("bim-normalizer stopped.")


app = FastAPI(
    title="bim-normalizer",
    description="Production BIM normalizer: Speckle → IFC schema → PostgreSQL",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "service": "bim-normalizer"}


# ---------------------------------------------------------------------------
# Dashboard share links
# ---------------------------------------------------------------------------

class _ShareBody(BaseModel):
    payload: dict

@app.post("/share")
def create_share(body: _ShareBody):
    """Store a dashboard snapshot and return a short share ID (share01–share99)."""
    global _share_counter
    if not _dashboard_shares:
        _share_counter = 0
    _share_counter = (_share_counter % 99) + 1
    share_id = f"share{_share_counter:02d}"
    server = body.payload.get("server") or {}
    _dashboard_shares[share_id] = {
        "payload": body.payload,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "server_url": server.get("url", "") if isinstance(server, dict) else "",
        "server_name": server.get("name", "") if isinstance(server, dict) else "",
        "project_id": body.payload.get("projectId") or "",
        "model_name": body.payload.get("modelName") or "",
    }
    return {"id": share_id}

@app.get("/share")
def list_shares():
    """List all active share links with their metadata (no payload)."""
    return sorted(
        [
            {
                "id": sid,
                "created_at": e.get("created_at", ""),
                "server_url": e.get("server_url", ""),
                "server_name": e.get("server_name", ""),
                "project_id": e.get("project_id", ""),
                "model_name": e.get("model_name", ""),
            }
            for sid, e in _dashboard_shares.items()
        ],
        key=lambda x: x["id"],
    )

@app.get("/share/{share_id}")
def get_share(share_id: str):
    """Retrieve a stored dashboard snapshot by share ID."""
    entry = _dashboard_shares.get(share_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Share link not found or expired")
    return {"payload": entry["payload"]}

@app.delete("/share/{share_id}")
def delete_share(share_id: str):
    """Delete a share link, freeing the slot for reuse."""
    if share_id not in _dashboard_shares:
        raise HTTPException(status_code=404, detail="Share link not found")
    del _dashboard_shares[share_id]
    return {"ok": True}


# ---------------------------------------------------------------------------
# Per-project default dashboard layout
# ---------------------------------------------------------------------------
# Unlike /share (ephemeral, explicitly-created links), this is the one
# persistent layout per project: what a browser with no localStorage state
# yet loads on first visit, instead of the bare grid defaults.

class _DashboardLayoutBody(BaseModel):
    payload: dict

@app.put("/dashboard-layout/{project_id}")
def save_dashboard_layout(project_id: str, body: _DashboardLayoutBody):
    """Save the current dashboard state as this project's default for new visitors."""
    import json
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO bim_dashboard_layouts (project_id, payload, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (project_id) DO UPDATE
                SET payload = EXCLUDED.payload, updated_at = NOW()
            """, (project_id, json.dumps(body.payload)))
        conn.commit()
        return {"ok": True}
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)

@app.get("/dashboard-layout/{project_id}")
def get_dashboard_layout(project_id: str):
    """Fetch the saved default dashboard layout for a project, if one exists."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT payload FROM bim_dashboard_layouts WHERE project_id = %s", (project_id,))
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="No default layout saved for this project")
        return {"payload": row[0]}
    finally:
        release_conn(conn)


@app.get("/servers")
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


@app.get("/auto-sync/servers")
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


@app.post("/auto-sync/servers")
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
        asyncio.create_task(asyncio.to_thread(scan_server, server_url, body.token))

    return {"status": "ok"}


@app.post("/webhooks/speckle/{webhook_row_id}")
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

    for jid, job in list(_ingest_jobs.items()):
        if (job.get("stream_id") == stream_id and job.get("commit_id") == commit_id
                and job["status"] in ("running", "pending")):
            return {"job_id": jid, "status": "pending"}

    job_id = str(uuid.uuid4())
    _ingest_jobs[job_id] = {
        "status": "running", "stream_id": stream_id, "commit_id": commit_id,
        "model_id": None, "error": None, "element_count": None,
    }

    async def _run():
        try:
            result = await asyncio.to_thread(
                ingest_commit, stream_id=stream_id, commit_id=commit_id,
                token=token, server_url=server_url,
            )
            _ingest_jobs[job_id].update({
                "status": "complete",
                "model_id": result["model_id"],
                "element_count": result["element_count"],
            })
            pruned = await asyncio.to_thread(_prune_stream_commits, stream_id)
            if pruned:
                logger.info("Pruned %d old commit(s) for stream %s", pruned, stream_id)
        except Exception as exc:
            logger.error("Webhook ingest error (job %s): %s", job_id, exc, exc_info=True)
            _ingest_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_ingest_jobs)

    asyncio.create_task(_run())
    logger.info("Webhook %s: started ingest job %s for commit %s", webhook_row_id, job_id, commit_id)
    return {"job_id": job_id, "status": "pending"}


# ---------------------------------------------------------------------------
# Chat / AI agent
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    model_id: str | None = None   # normalizer model UUID (bim_models.model_id)
    history: list = []
    ai_provider: str = "openai"
    ollama_config: dict | None = None
    lmstudio_config: dict | None = None
    mistral_config: dict | None = None
    model_context: dict | None = None  # optional frontend-supplied context (families, phases, worksets, etc.)


@app.post("/chat")
async def chat(request: ChatRequest):
    """
    Agentic chat endpoint. Calls the configured LLM with tools that can
    query the normalizer DB (filter elements, get summaries). Returns
    {text, elementIds, toolsUsed} so the frontend can highlight elements.
    """
    import os
    from chat.agent import run_chat_agent
    from db.connection import get_conn, release_conn

    if not request.model_id:
        raise HTTPException(status_code=400, detail="model_id is required")

    provider = request.ai_provider
    if provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY", "")
        model_name = "gpt-4o-mini"
        base_url = ""
    elif provider == "mistral":
        cfg = request.mistral_config or {}
        api_key = cfg.get("apiKey") or os.getenv("MISTRAL_API_KEY", "")
        model_name = cfg.get("model", "mistral-large-latest")
        base_url = ""
    elif provider == "ollama":
        cfg = request.ollama_config or {}
        api_key = ""
        model_name = cfg.get("model", "llama3")
        base_url = cfg.get("baseUrl", "http://localhost:11434")
    else:  # lmstudio
        cfg = request.lmstudio_config or {}
        api_key = ""
        model_name = cfg.get("model", "local-model")
        base_url = cfg.get("baseUrl", "http://localhost:1234/v1")

    conn = get_conn()
    try:
        result = await asyncio.to_thread(
            run_chat_agent,
            conn,
            request.model_id,
            request.message,
            request.history,
            provider,
            api_key,
            model_name,
            base_url,
            request.model_context,
        )
        return result
    except Exception as exc:
        logger.error("Chat agent error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        release_conn(conn)


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    SSE streaming variant of /chat. Yields events:
      data: {"type":"reasoning","text":"..."}
      data: {"type":"tool_start","name":"..."}
      data: {"type":"tool_done","name":"...","count":N}
      data: {"type":"text_delta","delta":"..."}
      data: {"type":"elements","ids":[...]}
      data: {"type":"done","toolsUsed":[...]}
    """
    import asyncio
    import os
    from chat.agent import stream_chat_agent
    from db.connection import get_conn, release_conn

    if not request.model_id:
        raise HTTPException(status_code=400, detail="model_id is required")

    provider = request.ai_provider
    if provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY", "")
        model_name = "gpt-4o-mini"
        base_url = ""
    elif provider == "mistral":
        cfg = request.mistral_config or {}
        api_key = cfg.get("apiKey") or os.getenv("MISTRAL_API_KEY", "")
        model_name = cfg.get("model", "mistral-large-latest")
        base_url = ""
    elif provider == "ollama":
        cfg = request.ollama_config or {}
        api_key = ""
        model_name = cfg.get("model", "llama3")
        base_url = cfg.get("baseUrl", "http://localhost:11434")
    else:  # lmstudio
        cfg = request.lmstudio_config or {}
        api_key = ""
        model_name = cfg.get("model", "local-model")
        base_url = cfg.get("baseUrl", "http://localhost:1234/v1")

    async def generator():
        conn = get_conn()
        try:
            for event in stream_chat_agent(
                conn,
                request.model_id,
                request.message,
                request.history,
                provider,
                api_key,
                model_name,
                base_url,
                request.model_context,
            ):
                yield event
                await asyncio.sleep(0)  # yield control so FastAPI can flush
        except Exception as exc:
            import traceback as _tb
            import json
            tb = _tb.format_exc()
            logger.error("Stream agent error: %s\n%s", exc, tb)
            # Include last 2 traceback lines so the client can show which file/line
            tb_tail = " | ".join(
                l.strip() for l in tb.splitlines() if l.strip() and not l.strip().startswith("Traceback")
            )[-300:]
            yield f"data: {json.dumps({'type': 'error', 'message': f'{type(exc).__name__}: {exc}', 'detail': tb_tail})}\n\n"
        finally:
            release_conn(conn)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )


# ---------------------------------------------------------------------------
# Ingest request model
# ---------------------------------------------------------------------------

class IngestRequest(BaseModel):
    stream_id: str
    commit_id: str
    token: str | None = None       # overrides env token if provided
    server_url: str | None = None  # overrides env server URL if provided
    force: bool = False            # bypass the "already ingested" fast path and re-run


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/ingest")
async def ingest(request: IngestRequest):
    from pipeline.normalize import ingest_commit
    from db.connection import get_conn, release_conn

    # Fast path: commit already ingested — return immediately without re-processing
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id::text, COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.stream_id = %s AND m.commit_id = %s
                GROUP BY m.model_id
            """, (request.stream_id, request.commit_id))
            row = cur.fetchone()
    finally:
        release_conn(conn)

    if row and row[1] > 0 and not request.force:
        logger.info("Commit %s already ingested (%d elements) — fast return", request.commit_id, row[1])
        return {"model_id": row[0], "status": "complete", "element_count": int(row[1])}

    # Deduplicate: reuse an existing running job for the same commit
    for jid, job in list(_ingest_jobs.items()):
        if (job.get("stream_id") == request.stream_id
                and job.get("commit_id") == request.commit_id
                and job["status"] in ("running", "pending")):
            return {"job_id": jid, "status": "pending"}

    # New ingest — start as a background asyncio task so the HTTP call returns immediately
    job_id = str(uuid.uuid4())
    _ingest_jobs[job_id] = {
        "status": "running",
        "stream_id": request.stream_id,
        "commit_id": request.commit_id,
        "model_id": None,
        "error": None,
        "element_count": None,
    }

    async def _run():
        try:
            result = await asyncio.to_thread(
                ingest_commit,
                stream_id=request.stream_id,
                commit_id=request.commit_id,
                token=request.token,
                server_url=request.server_url,
            )
            _ingest_jobs[job_id].update({
                "status": "complete",
                "model_id": result["model_id"],
                "element_count": result["element_count"],
            })
            pruned = await asyncio.to_thread(_prune_stream_commits, request.stream_id)
            if pruned:
                logger.info(
                    "Pruned %d old commit(s) for stream %s (keeping latest %d)",
                    pruned, request.stream_id, _STREAM_COMMIT_LIMIT,
                )
        except Exception as exc:
            logger.error("Background ingest error (job %s): %s", job_id, exc, exc_info=True)
            _ingest_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_ingest_jobs)

    asyncio.create_task(_run())
    logger.info("Ingest job %s started for commit %s", job_id, request.commit_id)
    return {"job_id": job_id, "status": "pending"}


@app.get("/ingest/status/{job_id}")
def ingest_status(job_id: str):
    """Poll the status of a background ingest job."""
    job = _ingest_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {k: v for k, v in job.items() if k not in ("stream_id", "commit_id")}


@app.get("/models")
def list_models():
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.model_id, m.stream_id, m.commit_id, m.branch_name,
                       m.source, m.author, m.message, m.ingested_at,
                       COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                GROUP BY m.model_id
                ORDER BY m.ingested_at DESC
            """)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@app.get("/models/{model_id}")
def get_model(model_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT m.*, COUNT(e.element_id) AS element_count
                FROM bim_models m
                LEFT JOIN bim_elements e ON e.model_id = m.model_id
                WHERE m.model_id = %s
                GROUP BY m.model_id
            """, (model_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            cols = [d[0] for d in cur.description]
        return dict(zip(cols, row))
    finally:
        release_conn(conn)


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    """
    Delete a model and all its associated elements, geometry, and parameters.
    After deletion the next /ingest for the same commit will re-classify from scratch.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT model_id FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            # Cascade deletes handle elements → geometry + parameters via FK
            cur.execute("DELETE FROM bim_models WHERE model_id = %s", (model_id,))
        conn.commit()
        logger.info("Deleted model %s", model_id)
        return {"deleted": model_id}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/elements")
def get_elements(model_id: str, category: str = None, ifc_class: str = None,
                 storey: str = None, name: str = None, speckle_id: str = None,
                 limit: int = 500, offset: int = 0):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        where = ["e.model_id = %s"]
        params: list = [model_id]
        if category:
            where.append("e.category ILIKE %s")
            params.append(f"%{category}%")
        if ifc_class:
            where.append("e.ifc_class = %s")
            params.append(ifc_class)
        if storey:
            where.append("e.storey ILIKE %s")
            params.append(f"%{storey}%")
        if name:
            where.append("e.name ILIKE %s")
            params.append(f"%{name}%")
        if speckle_id:
            where.append("e.speckle_id = %s")
            params.append(speckle_id)
        params += [limit, offset]

        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT element_id, application_id, speckle_id, speckle_type,
                       ifc_class, category, name, storey, hash
                FROM bim_elements e
                WHERE {' AND '.join(where)}
                ORDER BY category, name
                LIMIT %s OFFSET %s
            """, params)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@app.get("/elements/{element_id}")
def get_element(element_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT e.*, g.bbox_min, g.bbox_max, g.centroid, g.volume_m3, g.area_m2
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.element_id = %s
            """, (element_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Element not found")
            cols = [d[0] for d in cur.description]
            element = dict(zip(cols, row))

            cur.execute("""
                SELECT pset, key, value, datatype
                FROM bim_parameters
                WHERE element_id = %s
                ORDER BY pset, key
            """, (element_id,))
            element["parameters"] = [
                dict(zip(["pset", "key", "value", "datatype"], r))
                for r in cur.fetchall()
            ]
        return element
    finally:
        release_conn(conn)


@app.get("/diff/{model_a}/{model_b}")
def diff_models(model_a: str, model_b: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Added in B (exist in B, not in A)
            cur.execute("""
                SELECT b.speckle_id, b.ifc_class, b.category, b.name
                FROM bim_elements b
                WHERE b.model_id = %s
                  AND b.application_id IS NOT NULL
                  AND b.application_id <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM bim_elements a
                      WHERE a.model_id = %s AND a.application_id = b.application_id
                  )
            """, (model_b, model_a))
            added = cur.fetchall()
            added_cols = [d[0] for d in cur.description]

            # Removed from A (exist in A, not in B)
            cur.execute("""
                SELECT a.speckle_id, a.ifc_class, a.category, a.name
                FROM bim_elements a
                WHERE a.model_id = %s
                  AND a.application_id IS NOT NULL
                  AND a.application_id <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM bim_elements b
                      WHERE b.model_id = %s AND b.application_id = a.application_id
                  )
            """, (model_a, model_b))
            removed = cur.fetchall()

            # Changed (same application_id, different hash)
            cur.execute("""
                SELECT a.speckle_id AS speckle_id_a, b.speckle_id AS speckle_id_b,
                       a.category, a.name
                FROM bim_elements a
                JOIN bim_elements b ON a.application_id = b.application_id
                WHERE a.model_id = %s AND b.model_id = %s
                  AND a.hash != b.hash
                  AND a.application_id IS NOT NULL
                  AND a.application_id <> ''
            """, (model_a, model_b))
            changed = cur.fetchall()
            changed_cols = [d[0] for d in cur.description]

            # Category delta (B = current/newer, A = older/base)
            cur.execute("""
                SELECT COALESCE(a.category, b.category) AS category,
                       COALESCE(a.cnt, 0) AS current_count,
                       COALESCE(b.cnt, 0) AS other_count,
                       COALESCE(a.cnt, 0) - COALESCE(b.cnt, 0) AS delta
                FROM
                    (SELECT category, COUNT(*) cnt FROM bim_elements WHERE model_id = %s GROUP BY category) a
                FULL OUTER JOIN
                    (SELECT category, COUNT(*) cnt FROM bim_elements WHERE model_id = %s GROUP BY category) b
                ON a.category = b.category
                ORDER BY ABS(COALESCE(a.cnt,0) - COALESCE(b.cnt,0)) DESC
            """, (model_b, model_a))
            cat_rows = cur.fetchall()

            # Total element counts so the frontend can show "Unchanged" correctly
            cur.execute("""
                SELECT
                    SUM(CASE WHEN model_id = %s THEN 1 ELSE 0 END) AS current_total,
                    SUM(CASE WHEN model_id = %s THEN 1 ELSE 0 END) AS other_total
                FROM bim_elements
                WHERE model_id IN (%s, %s)
            """, (model_b, model_a, model_a, model_b))
            totals_row = cur.fetchone()
            current_total = int(totals_row[0] or 0)
            other_total   = int(totals_row[1] or 0)

        category_changes = [
            {"category": r[0] or "Unknown", "current_count": r[1], "other_count": r[2], "delta": r[3]}
            for r in cat_rows if r[3] != 0
        ]

        return {
            "model_a":       model_a,
            "model_b":       model_b,
            "added_count":   len(added),
            "removed_count": len(removed),
            "changed_count": len(changed),
            "current_total": current_total,
            "other_total":   other_total,
            "total_delta":   current_total - other_total,
            "element_ids":   [r[0] for r in added],    # speckle_ids of added elements
            "removed_ids":   [r[0] for r in removed],
            "changed_elements": [dict(zip(changed_cols, r)) for r in changed],
            "category_changes": category_changes,
        }
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/summary")
def get_model_summary(model_id: str):
    """
    Chart-ready aggregations for one normalised model.
    Returns counts + volume + area grouped by category, ifc_class, storey,
    plus parameter-derived distributions: material, profile, grade.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_summary as _summary
    conn = get_conn()
    try:
        # Verify model exists
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _summary(conn, model_id)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/qa")
def get_model_qa(model_id: str):
    """
    BIM data-quality assessment: missing names/storeys/geometry/materials,
    unclassified elements, duplicate application IDs, and a 0–1 quality score.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_qa as _qa
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qa(conn, model_id)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/qa/elements")
def get_model_qa_elements(model_id: str, issue: str, limit: int = 50):
    """
    Return the actual elements affected by a specific QA issue.
    issue: unclassified | no_geometry | no_name | no_storey | no_material | duplicate_ids
    Use GET /models/{model_id}/qa first to see issue counts.
    """
    VALID = {"unclassified", "no_geometry", "no_name", "no_storey", "no_material", "duplicate_ids"}
    if issue not in VALID:
        raise HTTPException(status_code=422, detail=f"issue must be one of: {', '.join(sorted(VALID))}")
    from db.connection import get_conn, release_conn
    from db.query import get_qa_elements as _qa_el
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qa_el(conn, model_id, issue, limit)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/export/csv")
def export_model_csv(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    storey: str = None,
):
    """
    Export elements as a streaming CSV with geometry quantities and key parameter fields.
    Columns: element_id, speckle_id, ifc_class, category, name, storey,
             volume_m3, area_m2, material, profile, grade
    """
    import csv
    import io
    from db.connection import get_conn, release_conn
    from db.query import get_elements_flat as _flat

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        result = _flat(conn, model_id, limit=999_999, offset=0,
                       category=category, ifc_class=ifc_class, storey=storey)
    finally:
        release_conn(conn)

    def _generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "element_id", "speckle_id", "ifc_class", "category", "name",
            "storey", "volume_m3", "area_m2", "material", "profile", "grade",
        ])
        yield buf.getvalue()
        for el in result.get("elements", []):
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow([
                el.get("element_id", ""),
                el.get("speckle_id", ""),
                el.get("ifc_class", ""),
                el.get("category", ""),
                el.get("name", ""),
                el.get("storey", ""),
                el.get("volume_m3", ""),
                el.get("area_m2", ""),
                el.get("material", ""),
                el.get("profile", ""),
                el.get("grade", ""),
            ])
            yield buf.getvalue()

    filename = f"model_{model_id[:8]}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/models/{model_id}/quantities")
def get_model_quantities(model_id: str, group_by: str = "ifc_class"):
    """
    5D quantity takeoff from the database — no IFC load required.
    Returns element counts + volume (m³) + area (m²) per group.
    group_by: 'ifc_class' (default), 'category', or 'storey'
    """
    from db.connection import get_conn, release_conn
    from db.query import get_quantity_takeoff as _qto
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qto(conn, model_id, group_by)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/elements/flat")
def get_elements_flat(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    storey: str = None,
    limit: int = 50000,
    offset: int = 0,
):
    """
    Flat element list enriched with geometry quantities and key parameter fields
    (material, profile, grade). The `id` field mirrors `speckle_id` so the
    dashboard viewer sync works without frontend changes.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_elements_flat as _flat
    conn = get_conn()
    try:
        return _flat(conn, model_id, limit=limit, offset=offset,
                     category=category, ifc_class=ifc_class, storey=storey)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/parameters/completeness")
def get_parameter_completeness(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    min_coverage: float = 0.0,
):
    """
    Parameter fill-rate report for a model.
    Returns [{canonical_key, key, pset, total, filled, missing, fill_pct}]
    sorted by coverage ascending (worst first).

    Optional filters:
      category   — restrict to elements of this category (ILIKE)
      ifc_class  — restrict to elements of this IFC class
      min_coverage — only return parameters below this fill % (e.g. 99.0 to see near-complete)
    """
    from db.connection import get_conn, release_conn
    from db.query import get_parameter_completeness as _completeness
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _completeness(conn, model_id, category=category, ifc_class=ifc_class, min_coverage=min_coverage)
    finally:
        release_conn(conn)


@app.get("/models/trend/{stream_id}")
def get_model_trend(stream_id: str):
    """
    Version history trend for a stream.
    Returns [{model_id, commit_id, branch_name, ingested_at, source, message,
              total_elements, by_category: {cat: count}}]
    ordered oldest → newest.  Used to plot element-count evolution over time.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_trend as _trend
    conn = get_conn()
    try:
        return _trend(conn, stream_id)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/parameters/keys")
def get_parameter_keys(model_id: str):
    """Return all distinct BIM parameter keys for this model, sorted by element coverage."""
    from db.connection import get_conn, release_conn
    from db.query import get_parameter_keys as _keys
    conn = get_conn()
    try:
        return _keys(conn, model_id)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/elements/nearby")
def get_elements_nearby(
    model_id: str,
    reference: str = None,
    x: float = None,
    y: float = None,
    z: float = None,
    radius_m: float = 5.0,
    category: str = None,
):
    """
    Find elements within `radius_m` meters of a reference element (speckle_id
    or name, via `reference`) or an explicit [x, y, z] coordinate in meters.

    Only elements with a populated `centroid_si` (ingested after this feature
    was added) are matched — older models need re-ingestion for proximity
    search to return results.
    """
    from db.connection import get_conn, release_conn
    from db.query import find_nearby_elements as _nearby

    if reference is None and (x is None or y is None or z is None):
        raise HTTPException(status_code=400, detail="Provide either 'reference' or all of x, y, z")

    origin = reference if reference is not None else [x, y, z]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        matches = _nearby(conn, model_id, origin=origin, radius_m=radius_m, category=category)
        return {"model_id": model_id, "radius_m": radius_m, "count": len(matches), "elements": matches}
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/timeline/params")
def get_timeline_params(model_id: str):
    """Discover parameters that can drive a 4D build-up animation."""
    from db.connection import get_conn, release_conn
    from db.timeline import get_timeline_params as _params
    conn = get_conn()
    try:
        return _params(conn, model_id)
    finally:
        release_conn(conn)


@app.get("/models/{model_id}/timeline/data")
def get_timeline_data(model_id: str, param_key: str):
    """Return elements grouped by param_key, sorted chronologically."""
    from db.connection import get_conn, release_conn
    from db.timeline import get_timeline_data as _data
    conn = get_conn()
    try:
        return _data(conn, model_id, param_key)
    finally:
        release_conn(conn)


# ---------------------------------------------------------------------------
# 4D Schedule (IFC work schedule)
# ---------------------------------------------------------------------------

@app.get("/models/{model_id}/schedule")
def get_schedule(model_id: str):
    """Return the full task tree with element speckle_ids for viewer sync."""
    from db.connection import get_conn, release_conn
    from db.schedule import get_schedule as _get
    conn = get_conn()
    try:
        return _get(conn, model_id)
    finally:
        release_conn(conn)


@app.post("/models/{model_id}/schedule/import")
async def import_schedule(model_id: str, file: UploadFile):
    """Import an IFC file containing IfcWorkSchedule into bim_tasks."""
    from db.connection import get_conn, release_conn
    from db.schedule import import_from_ifc

    filename = (file.filename or '').lower()
    if not filename.endswith('.ifc'):
        raise HTTPException(status_code=400, detail='Unsupported file type. Upload an IFC file containing IfcWorkSchedule.')

    content = await file.read()
    conn = get_conn()
    try:
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix='.ifc', delete=False) as f:
            f.write(content)
            tmp = f.name
        try:
            return import_from_ifc(conn, model_id, tmp)
        finally:
            os.unlink(tmp)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        release_conn(conn)


@app.get("/debug/inspect/{stream_id}/{commit_id}")
async def debug_inspect(stream_id: str, commit_id: str, limit: int = 5, offset: int = 0):
    """
    Fetch a Speckle commit (without storing) and report geometry structure.

    Returns:
    - category_breakdown: how many elements per category have/lack geometry
    - with_geometry:    first `limit` elements that have usable mesh data
    - without_geometry: `limit` elements starting at `offset` that have NO mesh
                        (use offset to page through the 839 to see what they are)
    """
    from speckle.fetch import fetch_commit, flatten_elements
    from ifc.geometry import _get_all_meshes
    from specklepy.objects import Base

    def _inspect():
        root, meta = fetch_commit(stream_id, commit_id)
        element_tuples = flatten_elements(root)

        def _dv_summary(obj):
            dv = getattr(obj, "displayValue", None)
            if dv is None:
                try:
                    dv = obj["@displayValue"]
                except Exception:
                    pass
            if dv is None:
                return None
            dv_list = dv if isinstance(dv, list) else [dv]
            out = []
            for item in dv_list:
                if not isinstance(item, Base):
                    out.append({"kind": type(item).__name__})
                    continue
                verts = getattr(item, "vertices", None) or getattr(item, "@vertices", None)
                n = 0
                first_t = "n/a"
                if verts and isinstance(verts, (list, tuple)) and len(verts) > 0:
                    first_t = type(verts[0]).__name__
                    if first_t in ("int", "float"):
                        n = len(verts) // 3
                out.append({
                    "speckle_type": getattr(item, "speckle_type", "?"),
                    "vertex_count": n,
                    "first_vertex_type": first_t,
                })
            return out

        def _elem_info(obj, hint=""):
            cat = getattr(obj, "category", None)
            if cat is None:
                props = getattr(obj, "properties", None) or {}
                cat = props.get("category") or props.get("Category") or ""
            return {
                "id":             getattr(obj, "id", "?"),
                "applicationId":  getattr(obj, "applicationId", None),
                "speckle_type":   getattr(obj, "speckle_type", "?"),
                "category":       str(cat) if cat else "",
                "category_hint":  hint,
                "name":           getattr(obj, "name", None) or getattr(obj, "type", None) or "",
                "displayValue":   _dv_summary(obj),
            }

        # Split into geo / no-geo using the same function as the ingest
        with_geo = []
        without_geo = []
        cat_with: dict[str, int] = {}
        cat_without: dict[str, int] = {}

        for obj, hint in element_tuples:
            cat = str(getattr(obj, "category", "") or hint or "")
            meshes = _get_all_meshes(obj)
            if meshes:
                with_geo.append((obj, hint))
                cat_with[cat] = cat_with.get(cat, 0) + 1
            else:
                without_geo.append((obj, hint))
                cat_without[cat] = cat_without.get(cat, 0) + 1

        return {
            "commit": meta,
            "total_elements":    len(element_tuples),
            "with_geometry":     len(with_geo),
            "without_geometry":  len(without_geo),
            "category_breakdown": {
                "with_geometry":    dict(sorted(cat_with.items(),    key=lambda x: -x[1])),
                "without_geometry": dict(sorted(cat_without.items(), key=lambda x: -x[1])),
            },
            "samples_with_geometry":    [_elem_info(o, h) for o, h in with_geo[:limit]],
            "samples_without_geometry": [_elem_info(o, h) for o, h in without_geo[offset:offset + limit]],
        }

    try:
        return await asyncio.to_thread(_inspect)
    except Exception as exc:
        logger.error("Inspect error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/debug/classify-inspect")
async def debug_classify_inspect(request: IngestRequest, limit: int = 20):
    """
    Fetch a Speckle commit (without storing) and show the raw classification
    signals on the first `limit` elements.  Use this to diagnose why Tekla
    (or any other source) elements are landing in 'Generic Models'.

    Returns for each element:
      speckle_type, obj.type, obj.category, obj.name,
      properties_keys (first 20 keys from the properties bag),
      classified_as (what classify_element would return)
    """
    from speckle.fetch import fetch_commit, flatten_elements
    from ifc.classify import classify_element

    def _run():
        root, meta = fetch_commit(request.stream_id, request.commit_id, token=request.token)
        tuples = flatten_elements(root)
        results = []
        for obj, hint in tuples[:limit]:
            st = getattr(obj, "speckle_type", "") or ""
            obj_type = getattr(obj, "type", None)
            obj_cat = getattr(obj, "category", None)
            obj_name = getattr(obj, "name", None)

            # Collect properties keys so we can see what's in the bag
            prop_keys = []
            for attr in ("properties", "parameters", "typeParameters"):
                bag = getattr(obj, attr, None)
                if isinstance(bag, dict):
                    prop_keys = list(bag.keys())[:30]
                    break
                elif hasattr(bag, "__dict__"):
                    prop_keys = list(bag.__dict__.keys())[:30]
                    break

            # Sample property values for category-like keys
            prop_category = None
            for attr in ("properties", "parameters"):
                bag = getattr(obj, attr, None)
                if isinstance(bag, dict):
                    for k in ("category", "Category", "CATEGORY", "CLASS", "class", "Type", "type"):
                        v = bag.get(k)
                        if v is not None:
                            prop_category = f"{k}={v!r}"
                            break
                if prop_category:
                    break

            # All top-level attribute keys on the object
            try:
                obj_keys = sorted(k for k in obj.__dict__.keys() if not k.startswith("__"))[:30]
            except Exception:
                obj_keys = []

            classification = classify_element(st, obj, hint)

            results.append({
                "speckle_type":     st,
                "obj_type":         str(obj_type) if obj_type is not None else None,
                "obj_category":     str(obj_cat) if obj_cat is not None else None,
                "obj_name":         str(obj_name) if obj_name is not None else None,
                "category_hint":    hint or None,
                "prop_category":    prop_category,
                "properties_keys":  prop_keys,
                "obj_keys":         obj_keys,
                "classified_as":    classification,
            })

        # Also show category distribution across ALL elements
        from collections import Counter
        all_cats = Counter(
            classify_element(
                getattr(o, "speckle_type", "") or "",
                o, h
            )["category"]
            for o, h in tuples
        )

        return {
            "commit": meta,
            "total_elements": len(tuples),
            "category_distribution": dict(all_cats.most_common()),
            "element_samples": results,
        }

    try:
        return await asyncio.to_thread(_run)
    except Exception as exc:
        logger.error("classify-inspect error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Classification overrides
# ---------------------------------------------------------------------------

class OverrideItem(BaseModel):
    application_id: str | None = None
    speckle_id: str | None = None
    ifc_class: str
    category: str
    note: str | None = None


@app.get("/models/{model_id}/overrides")
def list_overrides(model_id: str):
    """Return all per-element classification overrides for a model."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            cur.execute("""
                SELECT override_id, model_id, application_id, speckle_id,
                       ifc_class, category, note, created_at
                FROM bim_classification_overrides
                WHERE model_id = %s
                ORDER BY created_at DESC
            """, (model_id,))
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        release_conn(conn)


@app.post("/models/{model_id}/overrides")
def upsert_overrides(model_id: str, items: list[OverrideItem]):
    """
    Bulk-upsert classification overrides. Matches by application_id when present,
    otherwise by speckle_id. At least one of the two must be provided per item.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")

            upserted = 0
            for item in items:
                if not item.application_id and not item.speckle_id:
                    raise HTTPException(
                        status_code=422,
                        detail="Each override must have application_id or speckle_id"
                    )
                cur.execute("""
                    INSERT INTO bim_classification_overrides
                        (model_id, application_id, speckle_id, ifc_class, category, note)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (model_id, application_id)
                        WHERE application_id IS NOT NULL
                    DO UPDATE SET
                        ifc_class  = EXCLUDED.ifc_class,
                        category   = EXCLUDED.category,
                        note       = EXCLUDED.note,
                        created_at = NOW()
                """, (model_id, item.application_id, item.speckle_id,
                      item.ifc_class, item.category, item.note))
                upserted += 1
        conn.commit()
        return {"upserted": upserted}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@app.delete("/models/{model_id}/overrides/{override_id}")
def delete_override(model_id: str, override_id: str):
    """Delete a single classification override by its UUID."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM bim_classification_overrides
                WHERE override_id = %s AND model_id = %s
                RETURNING override_id
            """, (override_id, model_id))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Override not found")
        conn.commit()
        return {"deleted": override_id}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@app.post("/models/{model_id}/overrides/apply")
def apply_overrides(model_id: str):
    """
    Apply all stored overrides for a model: UPDATE bim_elements.ifc_class / category
    wherever an override matches by application_id or speckle_id.
    Returns the number of elements updated.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            cur.execute("""
                UPDATE bim_elements e
                SET ifc_class = o.ifc_class,
                    category  = o.category
                FROM bim_classification_overrides o
                WHERE o.model_id = e.model_id
                  AND o.model_id = %s
                  AND (
                      (o.application_id IS NOT NULL AND o.application_id = e.application_id)
                   OR (o.speckle_id     IS NOT NULL AND o.speckle_id     = e.speckle_id)
                  )
            """, (model_id,))
            updated = cur.rowcount
        conn.commit()
        logger.info("Applied %d overrides to model %s", updated, model_id)
        return {"updated": updated}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


# ---------------------------------------------------------------------------
# Classification map hot-reload
# ---------------------------------------------------------------------------

@app.post("/classification/reload")
def reload_classification():
    """
    Re-read all mapping config files from disk without restarting the service.
    Covers mapping_revit.json, mapping_ifc_class.json, and mapping_canonical.json.
    """
    from ifc.classify import reload_classification_maps
    reload_classification_maps()
    # Reload canonical parameter mapping
    import db.insert as _insert
    _insert._KEY_TO_CANONICAL, _insert._PSET_KEY_TO_CANONICAL = _insert._load_canonical_map()
    return {"status": "reloaded"}


@app.get("/models/{model_id}/elements/by-parameter")
def get_elements_by_parameter(
    model_id: str,
    key: str,
    value: str = "",
    op: str = "contains",
    limit: int = 100,
):
    """
    Filter elements by a BIM parameter key/value with optional numeric operator.
    op: 'contains' (default ILIKE), 'eq', 'gt', 'lt', 'gte', 'lte' (numeric).
    """
    from db.connection import get_conn, release_conn
    _OP_SQL = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
    allowed = {"contains", "eq"} | set(_OP_SQL)
    if op not in allowed:
        raise HTTPException(status_code=422, detail=f"op must be one of: {sorted(allowed)}")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")

            where = ["e.model_id = %s", "p.key ILIKE %s"]
            params: list = [model_id, f"%{key}%"]

            if op == "contains":
                where.append("p.value ILIKE %s")
                params.append(f"%{value}%")
            elif op == "eq":
                where.append("(p.value ILIKE %s OR (p.value_numeric IS NOT NULL AND p.value_numeric = %s))")
                try:
                    params += [value, float(value)]
                except ValueError:
                    params += [value, None]
            else:
                try:
                    num = float(value)
                except ValueError:
                    raise HTTPException(status_code=422, detail="Numeric value required for gt/lt/gte/lte")
                where.append(f"p.value_numeric {_OP_SQL[op]} %s AND p.value_numeric IS NOT NULL")
                params.append(num)

            params.append(limit)
            cur.execute(f"""
                SELECT DISTINCT ON (e.element_id)
                    e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey,
                    p.key AS param_key, p.value AS param_value
                FROM bim_elements e
                JOIN bim_parameters p ON p.element_id = e.element_id
                WHERE {' AND '.join(where)}
                ORDER BY e.element_id
                LIMIT %s
            """, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    except HTTPException:
        raise
    finally:
        release_conn(conn)


# ---------------------------------------------------------------------------
# Filter-publish: select elements → new Speckle commit
# ---------------------------------------------------------------------------

class FilterPublishRequest(BaseModel):
    speckle_ids: list[str] | None = None  # explicit IDs; if set, filters below are ignored
    category: str | None = None
    ifc_class: str | None = None
    storey: str | None = None
    target_branch: str = "filtered/selection"
    message: str = ""
    token: str | None = None
    server_url: str | None = None


@app.post("/models/{model_id}/filter-publish")
async def filter_publish(model_id: str, request: FilterPublishRequest):
    """
    Filter elements from a normalized model and publish the selection as a
    new commit on the same Speckle server.

    Filtering: provide any combination of category / ifc_class / storey for
    DB-based selection, OR an explicit speckle_ids list.  If speckle_ids is
    given the other filters are ignored.

    Returns {job_id} — poll GET /filter-publish/{job_id}/status for the result.
    """
    from db.connection import get_conn, release_conn
    from speckle.publish import filter_and_publish

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id, commit_id FROM bim_models WHERE model_id = %s",
                (model_id,),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Model not found")
            stream_id, commit_id = row[0], row[1]
    finally:
        release_conn(conn)

    job_id = str(uuid.uuid4())
    _filter_publish_jobs[job_id] = {"status": "running", "result": None, "error": None}

    async def _run():
        # Resolve speckle_ids
        speckle_ids: set[str] = set()
        if request.speckle_ids:
            speckle_ids = {s for s in request.speckle_ids if s}
        else:
            conn2 = get_conn()
            try:
                where = ["model_id = %s"]
                params: list = [model_id]
                if request.category:
                    where.append("category ILIKE %s")
                    params.append(f"%{request.category}%")
                if request.ifc_class:
                    where.append("ifc_class = %s")
                    params.append(request.ifc_class)
                if request.storey:
                    where.append("storey ILIKE %s")
                    params.append(f"%{request.storey}%")
                with conn2.cursor() as cur:
                    cur.execute(
                        f"SELECT speckle_id FROM bim_elements WHERE {' AND '.join(where)}",
                        params,
                    )
                    speckle_ids = {r[0] for r in cur.fetchall() if r[0]}
            finally:
                release_conn(conn2)

        if not speckle_ids:
            _filter_publish_jobs[job_id].update(
                {"status": "failed", "error": "No elements matched the filter criteria"}
            )
            return

        try:
            result = await asyncio.to_thread(
                filter_and_publish,
                stream_id=stream_id,
                commit_id=commit_id,
                speckle_ids=speckle_ids,
                target_branch=request.target_branch,
                message=request.message,
                token=request.token,
                server_url=request.server_url,
            )
            _filter_publish_jobs[job_id].update({"status": "complete", "result": result})
            pruned = await asyncio.to_thread(_prune_stream_commits, stream_id)
            if pruned:
                logger.info(
                    "Pruned %d old commit(s) for stream %s (keeping latest %d)",
                    pruned, stream_id, _STREAM_COMMIT_LIMIT,
                )
        except Exception as exc:
            logger.error("filter-publish job %s failed: %s", job_id, exc, exc_info=True)
            _filter_publish_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_filter_publish_jobs)

    asyncio.create_task(_run())
    logger.info("filter-publish job %s started for model %s", job_id, model_id)
    return {"job_id": job_id, "status": "pending"}


@app.get("/filter-publish/{job_id}/status")
def filter_publish_status(job_id: str):
    """Poll the status of a filter-publish job."""
    job = _filter_publish_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _load_export_data(model_id: str, coord_unit: str) -> tuple:
    """Fetch model row, elements, and parameters from DB. Runs synchronously."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM bim_models WHERE model_id = %s", (model_id,))
            row = cur.fetchone()
            if not row:
                raise ValueError(f"Model {model_id} not found")
            model_row = dict(zip([d[0] for d in cur.description], row))

            cur.execute("""
                SELECT e.element_id, e.application_id, e.ifc_class, e.category,
                       e.name, e.storey, e.speckle_type,
                       g.bbox_min, g.bbox_max, g.centroid,
                       g.mesh, g.volume_m3, g.area_m2
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s
                ORDER BY e.storey, e.category, e.name
            """, (model_id,))
            elements = [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]

            params_by_element: dict[str, list] = {}
            if elements:
                eids = [str(e["element_id"]) for e in elements]
                cur.execute("""
                    SELECT element_id::text, pset, key, value, datatype
                    FROM bim_parameters
                    WHERE element_id = ANY(%s::uuid[])
                    ORDER BY element_id, pset, key
                """, (eids,))
                for eid, pset, key, value, datatype in cur.fetchall():
                    params_by_element.setdefault(eid, []).append(
                        {"pset": pset, "key": key, "value": value, "datatype": datatype}
                    )
    finally:
        release_conn(conn)
    return model_row, elements, params_by_element


@app.post("/models/{model_id}/export/ifc")
async def start_export_ifc(model_id: str, coord_unit: str = "mm"):
    """
    Start an async IFC4X3 export job. Returns {job_id, status}.
    Poll GET /export/{job_id}/status, then download from GET /export/{job_id}/download.
    """
    from ifc.export import export_model

    job_id = str(uuid.uuid4())
    _export_jobs[job_id] = {"status": "running", "ifc_bytes": None, "filename": None, "error": None}

    async def _run():
        try:
            model_row, elements, params = await asyncio.to_thread(
                _load_export_data, model_id, coord_unit
            )
            model_name = model_row.get("branch_name") or model_row.get("commit_id", model_id)[:8]
            ifc_bytes = await asyncio.to_thread(
                export_model, model_row, elements, params, coord_unit
            )
            filename = f"{model_name}_{model_id[:8]}.ifc"
            _export_jobs[job_id].update({"status": "complete", "ifc_bytes": ifc_bytes, "filename": filename})
            logger.info("IFC export job %s complete: %d bytes", job_id, len(ifc_bytes))
        except Exception as exc:
            logger.error("IFC export job %s failed: %s", job_id, exc, exc_info=True)
            _export_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_export_jobs)

    asyncio.create_task(_run())
    return {"job_id": job_id, "status": "pending"}


@app.get("/models/{model_id}/export/ifc/{job_id}/status")
def export_job_status(model_id: str, job_id: str):
    """Poll the status of a background IFC export job."""
    job = _export_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    return {"job_id": job_id, "status": job["status"], "error": job.get("error")}


class OriginalIfcRequest(BaseModel):
    token: str | None = None       # overrides env token if provided
    server_url: str | None = None  # overrides env server URL if provided


@app.post("/streams/{stream_id}/original-ifc")
async def get_original_ifc(stream_id: str, request: OriginalIfcRequest | None = None):
    """
    Proxy-download the original IFC file blob attached to a Speckle stream.

    Browsers can't call the Speckle server's /api/stream/{id}/blob/{id} REST
    endpoint directly due to CORS, so the frontend routes the download through
    this normalizer endpoint instead.
    """
    from speckle.fetch import find_original_ifc_blob, iter_original_ifc_blob

    token = request.token if request else None
    server_url = request.server_url if request else None

    blob = await asyncio.to_thread(find_original_ifc_blob, stream_id, token, server_url)
    if blob is None:
        raise HTTPException(status_code=404, detail="No original IFC file found for this stream")

    headers = {
        "Content-Disposition": _content_disposition(blob["filename"]),
        "Content-Encoding": "identity",
    }
    if blob.get("file_size"):
        headers["Content-Length"] = str(blob["file_size"])

    return StreamingResponse(
        iter_original_ifc_blob(stream_id, blob),
        media_type="application/octet-stream",
        headers=headers,
    )


@app.get("/models/{model_id}/export/ifc/{job_id}/download")
def export_job_download(model_id: str, job_id: str):
    """Download the IFC file once the export job is complete. Cleans up the job after download."""
    job = _export_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    if job["status"] != "complete":
        raise HTTPException(status_code=409, detail=f"Export not ready: {job['status']}")
    ifc_bytes = job["ifc_bytes"]
    filename  = job.get("filename") or f"export_{job_id[:8]}.ifc"
    del _export_jobs[job_id]

    def _iter_bytes(data: bytes, chunk_size: int = 1024 * 1024):
        for i in range(0, len(data), chunk_size):
            yield data[i:i + chunk_size]

    return StreamingResponse(
        _iter_bytes(ifc_bytes),
        media_type="application/x-step",
        headers={
            "Content-Disposition": _content_disposition(filename),
            "Content-Encoding": "identity",
            "Content-Length": str(len(ifc_bytes)),
        },
    )


# ---------------------------------------------------------------------------
# IDS (Information Delivery Specification) checking
# ---------------------------------------------------------------------------
# Uploaded .ids files are stored per model (bim_ids_specs). Running a check
# exports the model to IFC (same pipeline as /export/ifc) and validates it
# with ifctester (ids_check.py), as a background job since both the export
# and the validation can take a while on large models.

@app.post("/models/{model_id}/ids-specs")
async def upload_ids_spec(model_id: str, file: UploadFile):
    """Upload and store an .ids file for this model. Rejects malformed IDS XML."""
    from ids_check import validate_ids_xml, InvalidIdsError
    from db.connection import get_conn, release_conn

    if not _is_uuid(model_id):
        raise HTTPException(status_code=400, detail=f"Invalid model id: {model_id!r}")

    raw = await file.read()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="IDS file must be UTF-8 encoded XML")

    try:
        await asyncio.to_thread(validate_ids_xml, content)
    except InvalidIdsError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid IDS file: {exc}")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail=f"Model {model_id} not found")
            cur.execute(
                """
                INSERT INTO bim_ids_specs (model_id, filename, content)
                VALUES (%s, %s, %s)
                RETURNING spec_id, filename, uploaded_at
                """,
                (model_id, file.filename or "spec.ids", content),
            )
            spec_id, filename, uploaded_at = cur.fetchone()
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except Exception as exc:
        conn.rollback()
        logger.error("IDS spec upload failed for model %s: %s", model_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")
    finally:
        release_conn(conn)
    return {"spec_id": str(spec_id), "filename": filename, "uploaded_at": uploaded_at.isoformat()}


@app.get("/models/{model_id}/ids-specs")
def list_ids_specs(model_id: str):
    """List previously uploaded .ids files for this model."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spec_id, filename, uploaded_at FROM bim_ids_specs WHERE model_id = %s ORDER BY uploaded_at DESC",
                (model_id,),
            )
            rows = cur.fetchall()
    finally:
        release_conn(conn)
    return [
        {"spec_id": str(r[0]), "filename": r[1], "uploaded_at": r[2].isoformat()}
        for r in rows
    ]


@app.get("/models/{model_id}/ids-specs/{spec_id}")
def get_ids_spec(model_id: str, spec_id: str):
    """Fetch one spec's raw IDS XML — used by the visual editor to load an
    existing spec back onto the canvas."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spec_id, filename, content, uploaded_at FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, spec_id),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)
    if not row:
        raise HTTPException(status_code=404, detail="IDS spec not found")
    return {"spec_id": str(row[0]), "filename": row[1], "content": row[2], "uploaded_at": row[3].isoformat()}


@app.delete("/models/{model_id}/ids-specs/{spec_id}", status_code=204)
def delete_ids_spec(model_id: str, spec_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, spec_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


class IdsCheckRequest(BaseModel):
    spec_id: str
    coord_unit: str = "mm"
    server_url: str | None = None  # overrides the model's stored ingest server, e.g. for a fresh token
    token: str | None = None       # overrides env token if provided


@app.post("/models/{model_id}/ids-check")
async def start_ids_check(model_id: str, body: IdsCheckRequest):
    """
    Start an async IDS check job: export the model to IFC, validate it
    against the stored spec, and keep the report in memory.
    Poll GET /ids-check/{job_id}/status for the result.
    """
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT content FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, body.spec_id),
            )
            row = cur.fetchone()
    finally:
        release_conn(conn)
    if not row:
        raise HTTPException(status_code=404, detail="IDS spec not found")
    ids_content = row[0]

    job_id = str(uuid.uuid4())
    _ids_check_jobs[job_id] = {"status": "running", "result": None, "error": None}

    async def _run():
        try:
            from ifc.export import export_model
            from ids_check import run_ids_check
            from speckle.fetch import fetch_original_ifc_bytes
            from db.connection import get_conn, release_conn

            # Prefer the real IFC file the source application (Revit/Tekla/IFC
            # connector) actually produced, when the Speckle stream has one
            # attached — IDS should validate the true exporter output, not
            # bim-normalizer's reconstruction (heuristic IFC-class assignment,
            # estimated storeys, mesh/bbox-only geometry, regenerated GUIDs).
            ids_conn = get_conn()
            try:
                with ids_conn.cursor() as cur:
                    cur.execute("SELECT stream_id, commit_id, server_url FROM bim_models WHERE model_id = %s", (model_id,))
                    stream_row = cur.fetchone()
            finally:
                release_conn(ids_conn)
            stream_id, commit_id, model_server_url = stream_row if stream_row else (None, None, None)

            # The model may have been ingested from a different Speckle server
            # than the one configured via SPECKLE_SERVER_URL (this app supports
            # switching between multiple servers, e.g. a self-hosted instance
            # and app.speckle.systems) — use whichever server it actually came
            # from, not whatever happens to be the env default, otherwise this
            # GraphQL lookup silently hits the wrong server and 404s as
            # "Stream not found".
            lookup_server_url = body.server_url or model_server_url
            ifc_bytes = None
            ifc_source = "synthetic_export"
            if stream_id:
                try:
                    ifc_bytes = await asyncio.to_thread(
                        fetch_original_ifc_bytes, stream_id, body.token, lookup_server_url, commit_id
                    )
                    if ifc_bytes is not None:
                        ifc_source = "original_ifc"
                except Exception as exc:
                    # A hard failure here (e.g. SPECKLE_TOKEN lacking access to
                    # this stream — surfaces as "GraphQL error: Stream not
                    # found") must not crash the whole job — fall back to the
                    # synthetic export the same as a clean "no original" result.
                    logger.warning(
                        "IDS check job %s: original IFC lookup failed for stream %s on %s (%s) — "
                        "falling back to synthetic export", job_id, stream_id, lookup_server_url, exc,
                    )

            if ifc_bytes is None:
                model_row, elements, params = await asyncio.to_thread(
                    _load_export_data, model_id, body.coord_unit
                )
                ifc_bytes = await asyncio.to_thread(
                    export_model, model_row, elements, params, body.coord_unit
                )

            logger.info("IDS check job %s: validating against %s (%d bytes)", job_id, ifc_source, len(ifc_bytes))
            result = await asyncio.to_thread(
                run_ids_check, ifc_bytes, ids_content, ifc_source == "synthetic_export",
            )
            _ids_check_jobs[job_id].update({"status": "complete", "result": result, "ifc_source": ifc_source})
            logger.info("IDS check job %s complete: status=%s", job_id, result.get("status"))
        except Exception as exc:
            logger.error("IDS check job %s failed: %s", job_id, exc, exc_info=True)
            _ids_check_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_ids_check_jobs)

    asyncio.create_task(_run())
    return {"job_id": job_id, "status": "pending"}


@app.get("/models/{model_id}/ids-check/{job_id}/status")
def ids_check_status(model_id: str, job_id: str):
    """Poll an IDS check job. Once status == 'complete', `result` holds the report.
    `ifc_source` indicates whether the check ran against the model's true
    original IFC file ("original_ifc") or bim-normalizer's reconstruction
    ("synthetic_export", used when no original IFC blob is attached)."""
    job = _ids_check_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="IDS check job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "error": job.get("error"),
        "result": job.get("result") if job["status"] == "complete" else None,
        "ifc_source": job.get("ifc_source"),
    }


# ---------------------------------------------------------------------------
# Clash detection
# ---------------------------------------------------------------------------
# Exports the model to IFC (same pipeline as /export/ifc and /ids-check) and
# runs real BVH mesh-level clash detection with ifcclash (clash_check.py),
# as a background job. selector_b is optional — omit it to clash a category
# against itself (e.g. "do any two structural columns occupy the same space").
# A job can hold multiple rules (e.g. "Columns vs Beams", "Pipes vs Ducts")
# run together against the same IFC export — see run_clash_checks.

class ClashRule(BaseModel):
    name: str | None = None
    selector_a: str
    selector_b: str | None = None
    mode: str = "collision"  # "collision" | "intersection" | "clearance"
    tolerance: float = 0.01
    clearance: float = 0.1
    allow_touching: bool = True


class ClashCheckRequest(BaseModel):
    rules: list[ClashRule]
    coord_unit: str = "mm"
    server_url: str | None = None  # overrides the model's stored ingest server, e.g. for a fresh token
    token: str | None = None       # overrides env token if provided


@app.post("/models/{model_id}/clash-check")
async def start_clash_check(model_id: str, body: ClashCheckRequest):
    """Start an async clash-detection job. Poll GET /clash-check/{job_id}/status for the result."""
    if not body.rules:
        raise HTTPException(status_code=400, detail="At least one rule is required")

    job_id = str(uuid.uuid4())
    _clash_check_jobs[job_id] = {"status": "running", "result": None, "error": None}

    async def _run():
        try:
            from ifc.export import export_model
            from clash_check import run_clash_checks
            from speckle.fetch import fetch_original_ifc_bytes
            from db.connection import get_conn, release_conn

            # Prefer the real IFC file the source application produced, when
            # available — same reasoning as /ids-check: bim-normalizer's own
            # re-export assigns every element a fresh, random GlobalId
            # (ifc/export.py uses ifcopenshell.guid.new()), unrelated to the
            # element's application_id. For that synthetic-export path,
            # run_clash_checks(resolve_application_ids=True) below substitutes
            # each clash's GlobalId with the element's Tag, which ifc/export.py
            # sets to application_id — so highlighting still works. A real
            # original IFC (e.g. Revit's own exporter output) assigns its own
            # GlobalIds/Tags with no relation to application_id, so 3D
            # highlighting still won't resolve for that path; this is a known,
            # accepted gap (no Revit UniqueId <-> IFC GlobalId mapping exists).
            clash_conn = get_conn()
            try:
                with clash_conn.cursor() as cur:
                    cur.execute("SELECT stream_id, commit_id, server_url FROM bim_models WHERE model_id = %s", (model_id,))
                    stream_row = cur.fetchone()
            finally:
                release_conn(clash_conn)
            stream_id, commit_id, model_server_url = stream_row if stream_row else (None, None, None)

            # Same reasoning as /ids-check: the model may have been ingested
            # from a different Speckle server than the env default (this app
            # supports switching between multiple servers) — use the server it
            # actually came from, otherwise this lookup 404s as "Stream not
            # found" against the wrong server.
            lookup_server_url = body.server_url or model_server_url
            ifc_bytes = None
            ifc_source = "synthetic_export"
            if stream_id:
                try:
                    ifc_bytes = await asyncio.to_thread(
                        fetch_original_ifc_bytes, stream_id, body.token, lookup_server_url, commit_id
                    )
                    if ifc_bytes is not None:
                        ifc_source = "original_ifc"
                except Exception as exc:
                    # Same reasoning as /ids-check: a hard failure here (e.g.
                    # SPECKLE_TOKEN lacking access to this stream) must not
                    # crash the whole job — fall back to the synthetic export.
                    logger.warning(
                        "Clash check job %s: original IFC lookup failed for stream %s on %s (%s) — "
                        "falling back to synthetic export", job_id, stream_id, lookup_server_url, exc,
                    )

            if ifc_bytes is None:
                model_row, elements, params = await asyncio.to_thread(
                    _load_export_data, model_id, body.coord_unit
                )
                ifc_bytes = await asyncio.to_thread(
                    export_model, model_row, elements, params, body.coord_unit
                )

            logger.info("Clash check job %s: checking against %s (%d bytes)", job_id, ifc_source, len(ifc_bytes))
            results = await asyncio.to_thread(
                run_clash_checks, ifc_bytes, [r.model_dump() for r in body.rules],
                ifc_source == "synthetic_export",
            )
            total = sum(r.get("count", 0) for r in results)
            _clash_check_jobs[job_id].update({
                "status": "complete",
                "result": {"rules": results, "total_count": total},
                "ifc_source": ifc_source,
            })
            logger.info("Clash check job %s complete: %d rule(s), %d total clashes", job_id, len(results), total)
        except Exception as exc:
            logger.error("Clash check job %s failed: %s", job_id, exc, exc_info=True)
            _clash_check_jobs[job_id].update({"status": "failed", "error": str(exc)})
        finally:
            _prune_jobs(_clash_check_jobs)

    asyncio.create_task(_run())
    return {"job_id": job_id, "status": "pending"}


@app.get("/models/{model_id}/clash-check/{job_id}/status")
def clash_check_status(model_id: str, job_id: str):
    """Poll a clash-detection job. Once status == 'complete', `result` holds the clash list.
    `ifc_source` indicates whether the check ran against the model's true
    original IFC file ("original_ifc") or bim-normalizer's reconstruction
    ("synthetic_export", used when no original IFC blob is attached — for
    this path, clash GlobalIds are already resolved to application_id
    server-side so 3D highlighting/screenshots work; for "original_ifc",
    a real exporter's own GlobalIds have no relation to application_id, so
    highlighting won't resolve there)."""
    job = _clash_check_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Clash check job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "error": job.get("error"),
        "result": job.get("result") if job["status"] == "complete" else None,
        "ifc_source": job.get("ifc_source"),
    }
