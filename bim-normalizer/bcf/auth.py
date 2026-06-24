import base64
import binascii

from fastapi import Header, HTTPException

from config import settings
from bcf.db import fetch_one
from bcf.oauth import is_valid_access_token
from bcf.password import verify_password


def require_bcf_auth(authorization: str | None = Header(None)) -> None:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    scheme, _, value = authorization.partition(" ")
    scheme = scheme.lower()

    if scheme == "bearer":
        token = value.strip()
        if settings.BCF_API_KEY and token == settings.BCF_API_KEY:
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
        if settings.BCF_API_KEY and password == settings.BCF_API_KEY:
            return
        user = fetch_one("SELECT password_hash FROM bcf_users WHERE email = %s", (username,))
        if user is not None and verify_password(password, user["password_hash"]):
            return
        raise HTTPException(status_code=401, detail="Invalid credentials")

    raise HTTPException(status_code=401, detail="Unsupported Authorization scheme")


def get_bearer_token(authorization: str | None = Header(None)) -> str:
    scheme, _, value = (authorization or "").partition(" ")
    if scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="This endpoint requires a Bearer token")
    return value.strip()
