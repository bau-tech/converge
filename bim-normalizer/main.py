import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from db.connection import init_pool, close_pool, get_conn, release_conn
from db.models import init_schema
from db.jobs import fail_stale_running_jobs
from process_pool import init_process_pool, close_process_pool

from routers.analytics import router as analytics_router
from routers.auth import router as auth_router
from routers.bsdd import router as bsdd_router
from routers.chat import router as chat_router
from routers.clash_check import router as clash_check_router
from routers.dashboard import router as dashboard_router
from routers.debug import router as debug_router
from routers.documents import router as documents_router
from routers.elements import router as elements_router
from routers.filter_publish import router as filter_publish_router
from routers.ids_check import router as ids_check_router
from routers.ifc_export import router as ifc_export_router
from routers.ingest import router as ingest_router
from routers.models import router as models_router
from routers.notifications import router as notifications_router
from routers.overrides import router as overrides_router
from routers.sync import router as sync_router
from routers.timeline import router as timeline_router

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


async def _resume_incomplete_embeddings() -> None:
    """One-shot catch-up pass at boot for models whose embeddings were left
    partway done — see db.query.get_models_with_incomplete_embeddings'
    docstring: a backend restart while generate_embeddings_for_model() is
    running kills it with nothing to resume it, since (unlike ingest) it
    isn't tracked in bim_jobs. Sequential, not concurrent — embeddings are
    already the single most CPU-heavy thing this process does; no benefit to
    overlapping several models' worth of it."""
    from db.connection import get_conn, release_conn
    from db.query import get_models_with_incomplete_embeddings
    from pipeline.normalize import generate_embeddings_for_model
    from process_pool import run_cpu_bound

    conn = get_conn()
    try:
        model_ids = get_models_with_incomplete_embeddings(conn)
    finally:
        release_conn(conn)

    if not model_ids:
        return
    logger.info("Resuming incomplete embeddings for %d model(s) after restart", len(model_ids))
    for model_id in model_ids:
        try:
            await run_cpu_bound(generate_embeddings_for_model, model_id=model_id)
        except Exception as exc:
            logger.warning("Resuming embeddings failed for model %s: %s", model_id, exc)


async def _document_sync_loop():
    """Drift detector for documents that reached Nextcloud some other way
    than through routers/documents.py's own upload/move/revise/delete calls
    (which already index as they go) — see nextcloud/reconcile.py."""
    from config import settings
    from db.connection import get_conn, release_conn
    from nextcloud.reconcile import reconcile_all_projects
    while True:
        try:
            conn = get_conn()
            try:
                indexed = await asyncio.to_thread(reconcile_all_projects, conn)
                if indexed:
                    logger.info("Document reconciliation indexed %d file(s)", indexed)
            finally:
                release_conn(conn)
        except Exception as exc:
            logger.error("Document reconciliation failed: %s", exc, exc_info=True)
        await asyncio.sleep(settings.DOCUMENT_SYNC_SCAN_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting bim-normalizer...")
    from config import settings
    if settings.DASHBOARD_AUTH_BYPASS:
        logger.warning(
            "DASHBOARD_AUTH_BYPASS is enabled — dashboard login and all ISO 19650 "
            "role checks are DISABLED. This must never be set outside local testing."
        )
    if settings.DASHBOARD_SESSION_SECRET_IS_INSECURE_DEFAULT:
        logger.warning(
            "DASHBOARD_SESSION_SECRET, BCF_OIDC_SECRET, and BCF_API_KEY are all unset — "
            "dashboard session cookies are signed with a hardcoded, publicly-known secret. "
            "Anyone can forge a valid session for any user/role. Set at least one of these "
            "env vars before deploying."
        )
    init_pool()
    init_schema()
    logger.info("DB schema ready.")
    conn = get_conn()
    try:
        fail_stale_running_jobs(conn)
    finally:
        release_conn(conn)
    init_process_pool()
    auto_sync_task = asyncio.create_task(_auto_sync_loop())
    document_sync_task = asyncio.create_task(_document_sync_loop())
    resume_embeddings_task = asyncio.create_task(_resume_incomplete_embeddings())
    yield
    auto_sync_task.cancel()
    document_sync_task.cancel()
    resume_embeddings_task.cancel()
    close_process_pool()
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


@app.get("/health")
def health():
    return {"status": "ok", "service": "bim-normalizer"}


app.include_router(auth_router)
app.include_router(bsdd_router)
app.include_router(dashboard_router)
app.include_router(sync_router)
app.include_router(chat_router)
app.include_router(ingest_router)
app.include_router(models_router)
app.include_router(elements_router)
app.include_router(analytics_router)
app.include_router(timeline_router)
app.include_router(debug_router)
app.include_router(overrides_router)
app.include_router(filter_publish_router)
app.include_router(ifc_export_router)
app.include_router(ids_check_router)
app.include_router(clash_check_router)
app.include_router(documents_router)
app.include_router(notifications_router)
