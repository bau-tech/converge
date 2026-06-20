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

# How often the background task re-scans watched servers for newly-created
# streams that don't have a webhook yet (existing streams sync instantly via
# their webhook regardless of this interval — see /webhooks/speckle/{id}).
AUTO_SYNC_SCAN_INTERVAL_S: int = int(os.getenv("AUTO_SYNC_SCAN_INTERVAL_S", str(15 * 60)))

PG_HOST: str = _require("PG_HOST")
PG_PORT: int = int(os.getenv("PG_PORT", "5432"))
PG_USER: str = _require("PG_USER")
PG_PASS: str = _require("PG_PASS")
PG_NAME: str = _require("PG_NAME")

PORT: int = int(os.getenv("PORT", "8002"))

BCF_API_KEY: str = os.getenv("BCF_API_KEY", "")
# Signs the fake OIDC id_token issued by the BCF OAuth2 shim (bcf/oauth.py).
# No real user accounts behind this — it exists only so OIDC-only clients
# like BIMcollab ZOOM complete their auth handshake.
BCF_OIDC_SECRET: str = os.getenv("BCF_OIDC_SECRET") or BCF_API_KEY or "dev-insecure-oidc-secret"
