"""
BCF-API server (2.1 + 3.0)
============================
Standalone FastAPI process (separate container from bim-normalizer, same
Dockerfile/build context — mirrors how speckle-mcp is wired in
docker-compose.yml). Talks to the same Postgres instance via its own
connection pool.

M0 confirmed (see the plan doc): BIMcollab ZOOM requires a real OAuth2/OIDC
login (bcf/oauth.py), not the spec's Basic-Auth fallback, and only
understands BCF 2.1 — so the project/topic/comment routers below are
mounted under both /bcf/2.1 and /bcf/3.0.

Configuration (env, same vars as bim-normalizer):
  PG_HOST / PG_PORT / PG_USER / PG_PASS / PG_NAME
  PORT             default 8004
  BCF_API_KEY      shared Bearer credential for our own dashboard's calls
  BCF_OIDC_SECRET  signs the fake id_token issued by bcf/oauth.py
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db.connection import init_pool, close_pool
from bcf.db_schema import init_bcf_schema
from bcf.versions import router as versions_router, BCF_VERSION, BCF_LEGACY_VERSION
from bcf.auth_discovery import router as auth_discovery_router
from bcf.oauth import router as oauth_router, compat_router as oauth_compat_router
from bcf.auth import require_bcf_auth
from bcf.projects import router as projects_router
from bcf.topics import router as topics_router
from bcf.comments import router as comments_router
from bcf.viewpoints import router as viewpoints_router
from bcf.bridge import router as bridge_router
from bcf.bcfxml import router as bcfxml_router

logging.basicConfig(
    level=getattr(logging, (os.getenv("LOG_LEVEL") or "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting bcf-server...")
    init_pool()
    init_bcf_schema()
    logger.info("bcf-server ready.")
    yield
    close_pool()
    logger.info("bcf-server stopped.")


app = FastAPI(
    title="bcf-server",
    description="BCF-API 3.0 server for BIM coordination topics/comments/viewpoints",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(versions_router)
app.include_router(auth_discovery_router)
app.include_router(oauth_router)
app.include_router(oauth_compat_router)

for _version in (BCF_LEGACY_VERSION, BCF_VERSION):
    _prefix = f"/bcf/{_version}"
    _auth = [Depends(require_bcf_auth)]
    app.include_router(projects_router, prefix=_prefix, dependencies=_auth)
    app.include_router(topics_router, prefix=_prefix, dependencies=_auth)
    app.include_router(comments_router, prefix=_prefix, dependencies=_auth)
    app.include_router(viewpoints_router, prefix=_prefix, dependencies=_auth)

app.include_router(bridge_router, dependencies=[Depends(require_bcf_auth)])
app.include_router(bcfxml_router, dependencies=[Depends(require_bcf_auth)])


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8004")))
