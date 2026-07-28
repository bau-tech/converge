"""
Login/session for the main dashboard SPA (distinct from bcf_server.py's
`/admin` panel session and its OAuth2 id_token, though all three ultimately
key off the same `bcf_users` table — see bcf/admin.py for the sibling
pattern this mirrors). A dedicated "purpose" claim keeps a token issued for
one of the three from ever being replayed as another, even though the
signing secrets may coincide via the same env-var fallback chain.
"""
import hashlib
import time

import jwt

from config import settings

SESSION_COOKIE = "dashboard_session"
SESSION_TTL_SECONDS = 8 * 3600

_SIGNING_KEY = hashlib.sha256(f"{settings.DASHBOARD_SESSION_SECRET}:dashboard".encode()).digest()


def create_session_token(user_guid: str, email: str, name: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "sub": user_guid, "email": email, "name": name,
            "iat": now, "exp": now + SESSION_TTL_SECONDS,
            "purpose": "dashboard_session",
        },
        _SIGNING_KEY,
        algorithm="HS256",
    )


def decode_session(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, _SIGNING_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if payload.get("purpose") != "dashboard_session":
        return None
    return payload
