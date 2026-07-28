import base64
import binascii
import hmac

from fastapi import Header, HTTPException

from config import settings
from bcf.db import fetch_one
from bcf.oauth import current_user, is_valid_access_token
from bcf.password import verify_password


def _consteq(a: str, b: str) -> bool:
    # Both require_bcf_auth's shared-secret checks compared credentials with
    # plain == (short-circuits on the first differing byte) — a real, if
    # slow, timing side-channel against the single BCF_API_KEY that gates
    # every BCF route. hmac.compare_digest runs in constant time regardless
    # of where the strings first differ.
    return hmac.compare_digest(a, b)


def require_bcf_auth(authorization: str | None = Header(None)) -> None:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, value = authorization.partition(" ")
    scheme = scheme.lower()

    if scheme == "bearer":
        token = value.strip()
        if settings.BCF_API_KEY and _consteq(token, settings.BCF_API_KEY):
            return
        if is_valid_access_token(token):
            return
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if scheme == "basic":
        # Two credentials are accepted: the dashboard's own shared BCF_API_KEY
        # as the password (username ignored — unchanged, existing behavior),
        # or a real bcf_users email/password pair. Needed because clients like
        # Solibri default to Basic auth and never attempt the OAuth2 flow.
        try:
            decoded = base64.b64decode(value.strip()).decode("utf-8")
        except (ValueError, binascii.Error):
            raise HTTPException(status_code=401, detail="Malformed Basic credentials")
        username, _, password = decoded.partition(":")
        if settings.BCF_API_KEY and _consteq(password, settings.BCF_API_KEY):
            return
        user = fetch_one("SELECT password_hash FROM bcf_users WHERE email = %s", (username,))
        if user is not None and verify_password(password, user["password_hash"]):
            return
        raise HTTPException(status_code=401, detail="Invalid credentials")

    raise HTTPException(status_code=401, detail="Unsupported Authorization scheme")


def get_current_bcf_user(authorization: str | None = Header(None)) -> dict:
    """
    Like require_bcf_auth, but returns an identity instead of just
    validating — for /current-user and /foundation/*/current-user, which
    previously required get_bearer_token (any non-"bearer" scheme, e.g. the
    Basic auth Solibri defaults to, got an unconditional 401) and then only
    checked _issued_tokens (populated exclusively by the OAuth code-exchange
    flow, so even a Bearer BCF_API_KEY — accepted everywhere else — 401'd
    here too). Accepts the same three credential types require_bcf_auth
    does, and reports a generic identity for the shared-key case since
    BCF_API_KEY isn't tied to any one bcf_users row.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, value = authorization.partition(" ")
    scheme = scheme.lower()

    if scheme == "bearer":
        token = value.strip()
        if settings.BCF_API_KEY and _consteq(token, settings.BCF_API_KEY):
            return {"id": "api-key", "name": "API Key", "email": ""}
        return current_user(token)

    if scheme == "basic":
        try:
            decoded = base64.b64decode(value.strip()).decode("utf-8")
        except (ValueError, binascii.Error):
            raise HTTPException(status_code=401, detail="Malformed Basic credentials")
        username, _, password = decoded.partition(":")
        if settings.BCF_API_KEY and _consteq(password, settings.BCF_API_KEY):
            return {"id": "api-key", "name": "API Key", "email": ""}
        user = fetch_one("SELECT guid, name, password_hash FROM bcf_users WHERE email = %s", (username,))
        if user is not None and verify_password(password, user["password_hash"]):
            return {"id": str(user["guid"]), "name": user["name"], "email": username}
        raise HTTPException(status_code=401, detail="Invalid credentials")

    raise HTTPException(status_code=401, detail="Unsupported Authorization scheme")
