"""
OAuth2/OIDC login, backed by real bcf_users accounts
======================================================
Some BCF clients (confirmed: BIMcollab ZOOM) refuse to use the
http_basic_supported fallback the BCF-API spec allows, and instead
require a real OAuth2 Authorization Code + PKCE flow with an `openid`
scope (i.e. they expect an ID token back).

/authorize renders a plain HTML login form (no templating engine — this
codebase has none, and one form doesn't warrant adding Jinja2) and only
issues a code once the submitted email/password match a bcf_users row.
"""

import base64
import hashlib
import secrets
import time

import jwt
from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from config import settings
from bcf.db import fetch_one
from bcf.password import verify_password

router = APIRouter(tags=["bcf-oauth"], prefix="/bcf-bridge/oauth2")

# BIMcollab ZOOM ignores oauth2_token_url from the /auth discovery response
# and hardcodes "/identity/connect/token" + "/identity/oauthredirect_remember_me"
# on whatever domain it was given — confirmed via M0 traffic logs. These paths
# have nothing to do with the BCF-API spec; they exist purely to match that
# client's hardcoded assumptions.
compat_router = APIRouter(tags=["bcf-oauth-compat"], prefix="/identity")

TOKEN_TTL_SECONDS = 3600

# In-memory only — codes/tokens don't need to survive a restart, this is a
# single-process auth server (real accounts live in Postgres; sessions don't).
_pending_codes: dict[str, dict] = {}
_issued_tokens: dict[str, dict] = {}
# Maps refresh_token -> {"email", "name"}. Needed because grant_type=refresh_token
# has no _pending_codes entry to recover identity from — without this, a
# reconnect would have no way to know which real user it's reissuing tokens
# for, defeating the point of real accounts.
_refresh_tokens: dict[str, dict] = {}
# RFC 7591 dynamic client registration. Needed because some BCF clients
# (confirmed: Solibri) treat themselves as a "confidential client" and
# unconditionally build an HTTP Basic client_id/client_secret credential for
# the token endpoint — with no UI to type a secret in and no registration
# endpoint to fetch one from, client_secret is null and their own OAuth
# library throws an NPE before ever making a request. We don't actually
# enforce these secrets anywhere (this whole shim has no real security
# model) — registration just hands out *something* non-null to satisfy that.
_registered_clients: dict[str, str] = {}


def _b64url_sha256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


# Hash whatever BCF_OIDC_SECRET is (it may be short, e.g. reused from
# BCF_API_KEY) into a fixed 32-byte HMAC key so PyJWT never warns about
# minimum key length, regardless of the configured secret's length.
_SIGNING_KEY = hashlib.sha256(settings.BCF_OIDC_SECRET.encode()).digest()


def _issue_tokens(base: str, client_id: str, email: str, name: str) -> dict:
    now = int(time.time())
    access_token = secrets.token_urlsafe(32)
    refresh_token = secrets.token_urlsafe(32)
    id_token = jwt.encode(
        {
            "iss": base,
            "sub": email,
            "aud": client_id,
            "iat": now,
            "exp": now + TOKEN_TTL_SECONDS,
            "name": name,
            "email": email,
        },
        _SIGNING_KEY,
        algorithm="HS256",
    )
    _issued_tokens[access_token] = {"sub": email, "name": name, "email": email, "exp": now + TOKEN_TTL_SECONDS}
    _refresh_tokens[refresh_token] = {"email": email, "name": name}
    return {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": TOKEN_TTL_SECONDS,
        "refresh_token": refresh_token,
        "id_token": id_token,
        "scope": "openid offline_access bcf",
    }


@router.post("/register")
async def register_client(request: Request):
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    client_id = secrets.token_urlsafe(16)
    client_secret = secrets.token_urlsafe(32)
    _registered_clients[client_id] = client_secret
    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "client_id_issued_at": int(time.time()),
        "client_secret_expires_at": 0,
        "redirect_uris": body.get("redirect_uris", []),
        "token_endpoint_auth_method": "client_secret_basic",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }


def _esc(v) -> str:
    return (v or "").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def _login_form_html(
    client_id: str, redirect_uri: str, response_type: str,
    code_challenge: str | None, code_challenge_method: str | None,
    state: str | None, scope: str | None, error: str | None = None,
) -> str:
    error_html = f'<p style="color:#c00">{_esc(error)}</p>' if error else ""
    return f"""<html><body>
      <h3>Sign in</h3>
      {error_html}
      <form method="post" action="/bcf-bridge/oauth2/authorize">
        <input type="hidden" name="client_id" value="{_esc(client_id)}">
        <input type="hidden" name="redirect_uri" value="{_esc(redirect_uri)}">
        <input type="hidden" name="response_type" value="{_esc(response_type)}">
        <input type="hidden" name="code_challenge" value="{_esc(code_challenge)}">
        <input type="hidden" name="code_challenge_method" value="{_esc(code_challenge_method)}">
        <input type="hidden" name="state" value="{_esc(state)}">
        <input type="hidden" name="scope" value="{_esc(scope)}">
        <label>Email <input type="email" name="email" required></label><br>
        <label>Password <input type="password" name="password" required></label><br>
        <button type="submit">Log in</button>
      </form>
    </body></html>"""


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
    return HTMLResponse(_login_form_html(
        client_id, redirect_uri, response_type,
        code_challenge, code_challenge_method, state, scope,
    ))


@router.post("/authorize")
def authorize_submit(
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    response_type: str = Form("code"),
    code_challenge: str | None = Form(None),
    code_challenge_method: str | None = Form(None),
    state: str | None = Form(None),
    scope: str | None = Form(None),
    email: str = Form(...),
    password: str = Form(...),
):
    user = fetch_one("SELECT email, name, password_hash FROM bcf_users WHERE email = %s", (email,))
    if user is None or not verify_password(password, user["password_hash"]):
        return HTMLResponse(
            _login_form_html(
                client_id, redirect_uri, response_type,
                code_challenge, code_challenge_method, state, scope,
                error="Invalid email or password",
            ),
            status_code=401,
        )

    code = secrets.token_urlsafe(24)
    _pending_codes[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "code_challenge_method": code_challenge_method or "plain",
        "user_email": user["email"],
        "user_name": user["name"],
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
        identity = _refresh_tokens.get(refresh_token or "")
        if identity is None:
            return {"error": "invalid_grant", "error_description": "unknown refresh token"}
        return _issue_tokens(base, client_id or "unknown", identity["email"], identity["name"])

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

    return _issue_tokens(base, client_id or pending["client_id"], pending["user_email"], pending["user_name"])


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


def current_user(access_token: str) -> dict:
    issued = _issued_tokens.get(access_token)
    if issued is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return {"id": issued["sub"], "name": issued.get("name", ""), "email": issued.get("email", "")}
