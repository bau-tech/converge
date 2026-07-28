"""
Login for the main dashboard SPA — real accounts against bcf_users (the same
table bcf-server's /admin panel and external BCF-client auth already use),
issuing a signed httpOnly session cookie. See dashboard_auth/session.py for
the token scheme and bcf/admin.py for the sibling pattern this mirrors.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from bcf.db import fetch_one
from bcf.password import verify_password
from dashboard_auth.dependencies import require_login, CurrentUser
from dashboard_auth.session import SESSION_COOKIE, SESSION_TTL_SECONDS, create_session_token

router = APIRouter(tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginRequest, request: Request, response: Response):
    user = fetch_one("SELECT guid, email, name, password_hash FROM bcf_users WHERE email = %s", (body.email,))
    if user is None or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_session_token(str(user["guid"]), user["email"], user["name"])
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, httponly=True,
        samesite="lax", secure=request.url.scheme == "https",
    )
    return {"guid": str(user["guid"]), "email": user["email"], "name": user["name"]}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/auth/me")
def me(user: CurrentUser = Depends(require_login)):
    return {"guid": user.guid, "email": user.email, "name": user.name}
