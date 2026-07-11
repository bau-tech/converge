import os
from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return v


SPECKLE_SERVER_URL: str = os.getenv("SPECKLE_SERVER_URL", "https://speckle.example.com")
SPECKLE_TOKEN: str = os.getenv("SPECKLE_TOKEN", "")

# Publicly reachable base URL for THIS app (reverse-proxied bim-normalizer, e.g.
# "https://dashboard.example.com/normalizer") — used to build the callback URL
# a Speckle server's webhookCreate is told to POST to. Required for auto-sync;
# left empty by default since it depends on the deployer's own DNS/proxy setup.
PUBLIC_BASE_URL: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")

# How often the background task re-scans watched servers as a dormant-project
# safety net for missed webhook deliveries (new-stream registration, missed
# commits, missed deletions) — see speckle/webhooks.py's scan_server(). A
# project someone actually opens gets scanned immediately via the frontend's
# on-load POST /auto-sync/scan instead of waiting for this interval; this
# background pass only matters for projects nobody has open.
AUTO_SYNC_SCAN_INTERVAL_S: int = int(os.getenv("AUTO_SYNC_SCAN_INTERVAL_S", str(60 * 60)))

PG_HOST: str = _require("PG_HOST")
PG_PORT: int = int(os.getenv("PG_PORT", "5432"))
PG_USER: str = _require("PG_USER")
PG_PASS: str = _require("PG_PASS")
PG_NAME: str = _require("PG_NAME")

PORT: int = int(os.getenv("PORT", "8002"))

BCF_API_KEY: str = os.getenv("BCF_API_KEY", "")
# Signs the OIDC id_token issued by the BCF OAuth2 login flow (bcf/oauth.py),
# now backed by real bcf_users accounts rather than a fake fixed identity.
BCF_OIDC_SECRET: str = os.getenv("BCF_OIDC_SECRET") or BCF_API_KEY or "dev-insecure-oidc-secret"

# Optional idempotent startup seed (bcf_server.py lifespan) for one bcf_users
# account — convenience only, not required: the admin panel itself is always
# reachable via BCF_API_KEY regardless of whether any bcf_users rows exist,
# so there's no lockout if these are left unset.
BCF_ADMIN_EMAIL: str = os.getenv("BCF_ADMIN_EMAIL", "")
BCF_ADMIN_PASSWORD: str = os.getenv("BCF_ADMIN_PASSWORD", "")
