"""
Login for the main dashboard SPA — real accounts against bcf_users (the same
table bcf-server's /admin panel and external BCF-client auth already use),
issuing a signed httpOnly session cookie. See dashboard_auth/session.py for
the token scheme and bcf/admin.py for the sibling pattern this mirrors.

Also the self-service "forgot password" flow (/auth/forgot-password,
/auth/reset-password) — before this, the only recovery option was an admin
manually resetting a user's password from bcf-server's /admin panel (see
bcf/admin.py's reset-password route).
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from bcf.db import execute, fetch_one
from bcf.password import hash_password, verify_password
from config import settings
from dashboard_auth.dependencies import require_login, CurrentUser
from dashboard_auth.session import SESSION_COOKIE, SESSION_TTL_SECONDS, create_session_token
from job_registry import fire_and_forget_sync
from notifications.email import send_email

router = APIRouter(tags=["auth"])
logger = logging.getLogger(__name__)

RESET_TOKEN_TTL = timedelta(hours=1)


class LoginRequest(BaseModel):
    email: str
    password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


def _hash_reset_token(token: str) -> str:
    # Same reasoning as bcf/password.py hashing real passwords — a DB dump
    # shouldn't hand out live, usable reset links. SHA-256 (not bcrypt) is
    # fine here: unlike a password, this token already has 256 bits of its
    # own entropy (secrets.token_urlsafe(32)), so it needs no deliberately-
    # slow hash to resist guessing.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post("/auth/login")
def login(body: LoginRequest, request: Request, response: Response):
    user = fetch_one(
        """
        SELECT u.guid, u.email, u.name, u.password_hash, u.org_id, o.name AS org_name
        FROM bcf_users u LEFT JOIN bcf_organizations o ON o.org_id = u.org_id
        WHERE u.email = %s
        """,
        (body.email,),
    )
    if user is None or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    org_id = str(user["org_id"]) if user["org_id"] else None
    token = create_session_token(str(user["guid"]), user["email"], user["name"], org_id, user["org_name"])
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, httponly=True,
        samesite="lax", secure=request.url.scheme == "https",
    )
    return {"guid": str(user["guid"]), "email": user["email"], "name": user["name"], "org_id": org_id, "org_name": user["org_name"]}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/auth/me")
def me(user: CurrentUser = Depends(require_login)):
    return {"guid": user.guid, "email": user.email, "name": user.name, "org_id": user.org_id, "org_name": user.org_name}


@router.post("/auth/forgot-password", status_code=204)
def forgot_password(body: ForgotPasswordRequest):
    """Always responds 204 whether or not the email matches an account —
    a differing response would let a caller enumerate which emails have
    accounts on this instance. Deliberately ignores notify_email (the
    per-user opt-out for document/BCF notification emails, see
    db_schema.py) — that's a notification *preference*, not a consent to
    skip a security-relevant transactional email the user themselves just
    requested."""
    user = fetch_one("SELECT guid, email, name FROM bcf_users WHERE email = %s", (body.email,))
    if user is None:
        return
    if not settings.PUBLIC_APP_URL:
        # No frontend URL to build a working link from — log for whoever
        # runs this deployment rather than silently emailing a dead link
        # (or worse, erroring back to the client and confirming the email
        # exists).
        logger.warning(
            "Password reset requested for %s but PUBLIC_APP_URL is not configured — no link to send",
            body.email,
        )
        return

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + RESET_TOKEN_TTL
    execute(
        "UPDATE bcf_users SET reset_token_hash = %s, reset_token_expires_at = %s WHERE guid = %s",
        (_hash_reset_token(token), expires_at, user["guid"]),
    )
    link = f"{settings.PUBLIC_APP_URL}/?resetToken={quote(token, safe='')}"
    message = (
        f"Hi {user['name']},\n\n"
        "Someone requested a password reset for your Converge account. "
        f"If this was you, set a new password here (valid for 1 hour):\n\n{link}\n\n"
        "If you didn't request this, you can ignore this email — your password won't change."
    )
    # Sync `def` route (FastAPI runs it off the event loop, in a worker
    # thread), so fire_and_forget_sync is the one that's safe to call here
    # — see job_registry.py's docstring for why fire_and_forget() itself
    # would silently fail in this context.
    fire_and_forget_sync(send_email, user["email"], "Converge — reset your password", message)


@router.post("/auth/reset-password")
def reset_password(body: ResetPasswordRequest, request: Request, response: Response):
    if not body.password:
        raise HTTPException(status_code=422, detail="Password is required")
    user = fetch_one(
        """
        SELECT u.guid, u.email, u.name, u.org_id, o.name AS org_name
        FROM bcf_users u LEFT JOIN bcf_organizations o ON o.org_id = u.org_id
        WHERE u.reset_token_hash = %s AND u.reset_token_expires_at > NOW()
        """,
        (_hash_reset_token(body.token),),
    )
    if user is None:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    execute(
        """
        UPDATE bcf_users
        SET password_hash = %s, reset_token_hash = NULL, reset_token_expires_at = NULL
        WHERE guid = %s
        """,
        (hash_password(body.password), user["guid"]),
    )

    # Log the user straight in — same session cookie as /auth/login — so
    # resetting a password doesn't dead-end back at the login form asking
    # for the password they just set.
    org_id = str(user["org_id"]) if user["org_id"] else None
    token = create_session_token(str(user["guid"]), user["email"], user["name"], org_id, user["org_name"])
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, httponly=True,
        samesite="lax", secure=request.url.scheme == "https",
    )
    return {"guid": str(user["guid"]), "email": user["email"], "name": user["name"], "org_id": org_id, "org_name": user["org_name"]}
