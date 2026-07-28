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


def _parse_extra_speckle_servers(raw: str) -> dict[str, str]:
    """Same "name|url|token" comma-separated format and env var as the
    frontend's VITE_EXTRA_SPECKLE_SERVERS (App.jsx's ENV_EXTRA_SERVERS) —
    reused here (as a plain, non-VITE_-only runtime env var passed to this
    container too) so bcf-server can pick the right token per Speckle server
    instead of always using the single SPECKLE_TOKEN default. Since VITE_
    env vars are baked into the client bundle and shipped to the browser
    already, these tokens are not newly-exposed secrets by reading them
    server-side too. Returns {server_url (no trailing slash): token}.
    """
    servers: dict[str, str] = {}
    if not raw:
        return servers
    for entry in raw.split(","):
        parts = entry.strip().split("|")
        if len(parts) < 2:
            continue
        url = parts[1].strip().rstrip("/")
        token = parts[2].strip() if len(parts) > 2 else ""
        if url and token:
            servers[url] = token
    return servers


# url -> token, for every Speckle server this deployment knows a token for
# (the default one plus VITE_EXTRA_SPECKLE_SERVERS) — used by
# bcf/admin.py's project-name lookup to authenticate against whichever
# server a given project actually lives on, not just the default.
SPECKLE_SERVER_TOKENS: dict[str, str] = {
    SPECKLE_SERVER_URL.rstrip("/"): SPECKLE_TOKEN,
    **_parse_extra_speckle_servers(os.getenv("VITE_EXTRA_SPECKLE_SERVERS", "")),
}

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

# Signs the main dashboard's own login session cookie (dashboard_auth/session.py),
# backed by the same bcf_users accounts as the BCF admin panel/OAuth login but
# with a distinct "purpose" claim so a token for one can never be replayed as
# another. Same fallback-chain convention as BCF_OIDC_SECRET above.
DASHBOARD_SESSION_SECRET: str = os.getenv("DASHBOARD_SESSION_SECRET") or BCF_OIDC_SECRET

# True only when DASHBOARD_SESSION_SECRET ends up as the hardcoded
# "dev-insecure-oidc-secret" literal (i.e. DASHBOARD_SESSION_SECRET,
# BCF_OIDC_SECRET, and BCF_API_KEY are all unset) — anyone who knows that
# public string can forge a session cookie for any user/role. Checked at
# startup (main.py's lifespan) so this can't go unnoticed the way
# DASHBOARD_AUTH_BYPASS explicitly warns but this fallback chain previously
# didn't.
DASHBOARD_SESSION_SECRET_IS_INSECURE_DEFAULT: bool = DASHBOARD_SESSION_SECRET == "dev-insecure-oidc-secret"

# DEV/TESTING ONLY — skips the dashboard login screen and all ISO 19650
# author/reviewer/approver role checks entirely (dashboard_auth/dependencies.py).
# Must default to disabled; only ever set this in a local .env, never in
# docker-compose.yml or any deployed environment's env vars. A startup log
# line fires whenever this is on so an accidental production deploy isn't
# silent (see main.py's lifespan).
DASHBOARD_AUTH_BYPASS: bool = os.getenv("DASHBOARD_AUTH_BYPASS", "").strip().lower() in ("1", "true", "yes")

# Nextcloud (document storage/versioning backend, see nextcloud/client.py).
# Defaults point at the bundled docker-compose container — swapping to a
# different Nextcloud instance later is just a config change.
NEXTCLOUD_URL: str = os.getenv("NEXTCLOUD_URL", "http://nextcloud").rstrip("/")
NEXTCLOUD_USER: str = os.getenv("NEXTCLOUD_USER", "admin")
# Used only by nextcloud/provisioning.py's OCS Provisioning API calls (create
# user/group), which require the admin account specifically — separate from
# NEXTCLOUD_USER/NEXTCLOUD_APP_PASSWORD so the day-to-day WebDAV client can
# later be switched to a lower-privilege service account without breaking
# provisioning.
NEXTCLOUD_ADMIN_USER: str = os.getenv("NEXTCLOUD_ADMIN_USER", "admin")
NEXTCLOUD_ADMIN_PASSWORD: str = os.getenv("NEXTCLOUD_ADMIN_PASSWORD", "")
# Falls back to the raw admin password so the stack works right after first
# bring-up; generate a real app password via Nextcloud's Security settings
# and set NEXTCLOUD_APP_PASSWORD once the container is up, same pattern as
# BCF_OIDC_SECRET falling back to BCF_API_KEY above.
NEXTCLOUD_APP_PASSWORD: str = os.getenv("NEXTCLOUD_APP_PASSWORD") or NEXTCLOUD_ADMIN_PASSWORD
DOCUMENT_SYNC_SCAN_INTERVAL_S: int = int(os.getenv("DOCUMENT_SYNC_SCAN_INTERVAL_S", str(60 * 60)))
