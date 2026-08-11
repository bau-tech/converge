"""
BCF-API server (2.1 + 3.0)
============================
Standalone FastAPI process (separate container from bim-normalizer, same
Dockerfile/build context — mirrors how converge-mcp is wired in
docker-compose.yml). Talks to the same Postgres instance via its own
connection pool.

M0 confirmed (see the plan doc): BIMcollab ZOOM requires a real OAuth2/OIDC
login (bcf/oauth.py), not the spec's Basic-Auth fallback, and only
understands BCF 2.1 — so the project/topic/comment routers below are
mounted under both /bcf/2.1 and /bcf/3.0.

Configuration (env, same vars as bim-normalizer):
  PG_HOST / PG_PORT / PG_USER / PG_PASS / PG_NAME
  PORT             default 8004
  BCF_API_KEY        shared Bearer credential for our own dashboard's calls
  BCF_OIDC_SECRET    signs the id_token issued by bcf/oauth.py
  BCF_ADMIN_EMAIL/PASSWORD  optional one-time bootstrap bcf_users seed
"""

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from db.connection import init_pool, close_pool
from bcf.db_schema import init_bcf_schema
from bcf.db import execute
from bcf.password import hash_password
from bcf import request_log
from bcf.versions import router as versions_router, BCF_VERSION, BCF_LEGACY_VERSION
from bcf.auth_discovery import router as auth_discovery_router
from bcf.foundation import router as foundation_router
from bcf.oauth import router as oauth_router, compat_router as oauth_compat_router
from bcf.auth import require_bcf_auth
from bcf.projects import router as projects_router
from bcf.topics import router as topics_router
from bcf.comments import router as comments_router
from bcf.viewpoints import router as viewpoints_router
from bcf.bridge import router as bridge_router
from bcf.bcfxml import router as bcfxml_router
from bcf.users import router as users_router
from bcf.admin import router as admin_router
from config import settings

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
    if settings.BCF_ADMIN_EMAIL and settings.BCF_ADMIN_PASSWORD:
        # Convenience only — ON CONFLICT DO NOTHING means this never resets
        # the password on later restarts, and skipping it entirely is fine
        # too: the admin panel is reachable via BCF_API_KEY regardless of
        # whether any bcf_users rows exist yet.
        execute(
            """
            INSERT INTO bcf_users (email, name, password_hash)
            VALUES (%s, %s, %s)
            ON CONFLICT (email) DO NOTHING
            """,
            (settings.BCF_ADMIN_EMAIL, "Admin", hash_password(settings.BCF_ADMIN_PASSWORD)),
        )
        logger.info("Bootstrap admin account ensured (%s).", settings.BCF_ADMIN_EMAIL)
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


@app.middleware("http")
async def _log_requests(request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    # /health is polled every few seconds by Docker and would otherwise
    # drown out the handful of real BCF client requests this log exists to
    # show (see the admin panel's "Recent requests" view).
    if request.url.path != "/health":
        request_log.record(
            request.method,
            request.url.path,
            response.status_code,
            request.client.host if request.client else None,
            (time.perf_counter() - start) * 1000,
        )
        # TEMPORARY diagnostic — logs the exact response body for the calls
        # BIMcollab ZOOM makes right before it blocks issue creation with
        # "no assignable team members" (current-user/extensions/topics),
        # to rule out any byte-level mismatch a manual re-test wouldn't
        # catch. Remove once the ZOOM issue is resolved.
        if request.method == "GET" and any(
            marker in request.url.path for marker in ("/current-user", "/extensions", "/topics")
        ):
            body = b"".join([chunk async for chunk in response.body_iterator])
            logger.info("DIAG %s %s -> %s", request.method, request.url.path, body[:2000])
            response = Response(
                content=body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type,
            )
    return response


app.include_router(versions_router)
app.include_router(auth_discovery_router)
app.include_router(foundation_router)
app.include_router(oauth_router)
app.include_router(oauth_compat_router)
# admin.py manages its own per-route session-cookie auth (require_admin_session) —
# it must NOT get the blanket require_bcf_auth dependency below, since /admin/login
# itself has to stay reachable without any credential at all.
app.include_router(admin_router)

for _version in (BCF_LEGACY_VERSION, BCF_VERSION):
    _prefix = f"/bcf/{_version}"
    _auth = [Depends(require_bcf_auth)]
    app.include_router(projects_router, prefix=_prefix, dependencies=_auth)
    app.include_router(topics_router, prefix=_prefix, dependencies=_auth)
    app.include_router(comments_router, prefix=_prefix, dependencies=_auth)
    app.include_router(viewpoints_router, prefix=_prefix, dependencies=_auth)

app.include_router(bridge_router, dependencies=[Depends(require_bcf_auth)])
app.include_router(bcfxml_router, dependencies=[Depends(require_bcf_auth)])
app.include_router(users_router, dependencies=[Depends(require_bcf_auth)])


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    # forwarded_allow_ips="*": this process only ever sees traffic from the
    # reverse proxy (NPM) inside the docker network, never directly from the
    # internet — without this, Uvicorn ignores the proxy's X-Forwarded-Proto
    # and every URL we build from request.base_url comes out as "http://"
    # even though the public-facing connection is HTTPS (confirmed: broke
    # Solibri's BCF connector, which actually uses oauth2_auth_url/token_url
    # from our /auth response, unlike BIMcollab ZOOM which hardcodes its own).
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8004")),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
