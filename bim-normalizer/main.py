import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from db.connection import init_pool, close_pool
from db.models import init_schema

from routers.analytics import router as analytics_router
from routers.chat import router as chat_router
from routers.clash_check import router as clash_check_router
from routers.dashboard import router as dashboard_router
from routers.debug import router as debug_router
from routers.elements import router as elements_router
from routers.filter_publish import router as filter_publish_router
from routers.ids_check import router as ids_check_router
from routers.ifc_export import router as ifc_export_router
from routers.ingest import router as ingest_router
from routers.models import router as models_router
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


@app.get("/health")
def health():
    return {"status": "ok", "service": "bim-normalizer"}


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
