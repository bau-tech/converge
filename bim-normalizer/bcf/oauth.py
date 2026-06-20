"""
Minimal fake OAuth2/OIDC shim
=============================
Some BCF clients (confirmed: BIMcollab ZOOM) refuse to use the
http_basic_supported fallback the BCF-API spec allows, and instead
require a real OAuth2 Authorization Code + PKCE flow with an `openid`
scope (i.e. they expect an ID token back).

There are no real user accounts behind this — every authorize request is
auto-approved with a fixed identity, and the issued id_token is just signed
well enough that OIDC-shaped clients accept it. This exists purely to
satisfy client-side protocol expectations, not for security.
"""

import base64
import hashlib
import secrets
import time

import jwt
from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from config import settings

router = APIRouter(tags=["bcf-oauth"], prefix="/bcf-bridge/oauth2")

# BIMcollab ZOOM ignores oauth2_token_url from the /auth discovery response
# and hardcodes "/identity/connect/token" + "/identity/oauthredirect_remember_me"
# on whatever domain it was given — confirmed via M0 traffic logs. These paths
# have nothing to do with the BCF-API spec; they exist purely to match that
# client's hardcoded assumptions.
compat_router = APIRouter(tags=["bcf-oauth-compat"], prefix="/identity")

FAKE_USER_NAME = "BCF Server"
FAKE_USER_EMAIL = "bcf-server@local"
TOKEN_TTL_SECONDS = 3600

# In-memory only — codes/tokens don't need to survive a restart, this is a
# single-process shim, not a real auth server.
_pending_codes: dict[str, dict] = {}
_issued_tokens: dict[str, dict] = {}


def _b64url_sha256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


# Hash whatever BCF_OIDC_SECRET is (it may be short, e.g. reused from
# BCF_API_KEY) into a fixed 32-byte HMAC key so PyJWT never warns about
# minimum key length, regardless of the configured secret's length.
_SIGNING_KEY = hashlib.sha256(settings.BCF_OIDC_SECRET.encode()).digest()


def _issue_tokens(base: str, client_id: str) -> dict:
    now = int(time.time())
    access_token = secrets.token_urlsafe(32)
    refresh_token = secrets.token_urlsafe(32)
    id_token = jwt.encode(
        {
            "iss": base,
            "sub": "bcf-server-user",
            "aud": client_id,
            "iat": now,
            "exp": now + TOKEN_TTL_SECONDS,
            "name": FAKE_USER_NAME,
            "email": FAKE_USER_EMAIL,
        },
        _SIGNING_KEY,
        algorithm="HS256",
    )
    _issued_tokens[access_token] = {"sub": "bcf-server-user", "exp": now + TOKEN_TTL_SECONDS}
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_SECONDS,
        "refresh_token": refresh_token,
        "id_token": id_token,
        "scope": "openid offline_access bcf",
    }


@router.get("/authorize")
def authorize(
    client_id: str,
    redirect_uri: str,
    response_type: str = "code",
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
    state: str | None = None,
    scope: str | None = None,
):
    code = secrets.token_urlsafe(24)
    _pending_codes[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method or "plain",
    }
    separator = "&" if "?" in redirect_uri else "?"
    location = f"{redirect_uri}{separator}code={code}"
    if state:
        location += f"&state={state}"
    return RedirectResponse(location, status_code=302)


async def _token_impl(
    request: Request,
    grant_type: str = Form(...),
    code: str | None = Form(None),
    redirect_uri: str | None = Form(None),
    client_id: str | None = Form(None),
    code_verifier: str | None = Form(None),
    refresh_token: str | None = Form(None),
):
    base = str(request.base_url).rstrip("/")

    if grant_type == "refresh_token":
        # No real validation of the refresh token — just hand out a fresh
        # set, matching the "protocol shape, not security" intent.
        return _issue_tokens(base, client_id or "unknown")

    pending = _pending_codes.pop(code or "", None)
    if pending is None:
        return {"error": "invalid_grant", "error_description": "unknown or already-used code"}

    if pending["code_challenge"]:
        method = pending["code_challenge_method"]
        verifier = code_verifier or ""
        expected = (
            _b64url_sha256(verifier) if method == "S256" else verifier
        )
        if expected != pending["code_challenge"]:
            return {"error": "invalid_grant", "error_description": "PKCE verification failed"}

    return _issue_tokens(base, client_id or pending["client_id"])


router.post("/token")(_token_impl)
compat_router.post("/connect/token")(_token_impl)


@compat_router.get("/oauthredirect_remember_me")
def oauthredirect_remember_me():
    # ZOOM's embedded browser navigates here after /authorize redirects back
    # with the code — it appears to extract the code from the URL itself
    # rather than needing anything from this response, but it must not 404.
    return HTMLResponse("<html><body>You can close this window.</body></html>")


def is_valid_access_token(token: str) -> bool:
    issued = _issued_tokens.get(token)
    if issued is None:
        return False
    if issued["exp"] < int(time.time()):
        del _issued_tokens[token]
        return False
    return True


def current_user() -> dict:
    return {"id": "bcf-server-user", "name": FAKE_USER_NAME, "email": FAKE_USER_EMAIL}
