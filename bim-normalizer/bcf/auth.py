from fastapi import Header, HTTPException

from config import settings
from bcf.oauth import is_valid_access_token


def require_bcf_auth(authorization: str | None = Header(None)) -> None:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[len("Bearer "):].strip()

    if settings.BCF_API_KEY and token == settings.BCF_API_KEY:
        return
    if is_valid_access_token(token):
        return
    raise HTTPException(status_code=401, detail="Invalid or expired token")
