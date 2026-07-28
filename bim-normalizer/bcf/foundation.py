"""
OpenCDE Foundation API
=======================
BCF 3.0 is an OpenCDE API, and OpenCDE requires every implementation to also
expose the shared Foundation API (auth/current-user) under its own
/foundation/{version}/ path, separate from /bcf/{version}/. Confirmed by a
real client calling GET /foundation/1.0/auth (404, before our fix) and only
succeeding via the /bcf/2.1/auth fallback — Foundation-aware clients look
here first and may not retry the resource entirely if it 404s.

The /versions payload (shared with bcf/versions.py) already advertises this
API's api_base_url; the routes below are what actually need to exist behind it.
"""

from fastapi import APIRouter, Depends, Request

from bcf.auth import get_current_bcf_user
from bcf.auth_discovery import auth_response
from bcf.versions import FOUNDATION_VERSION, FOUNDATION_LEGACY_VERSION

router = APIRouter(tags=["bcf-foundation"])


@router.get(f"/foundation/{FOUNDATION_VERSION}/auth")
def get_foundation_auth(request: Request):
    return auth_response(str(request.base_url).rstrip("/"))


@router.get(f"/foundation/{FOUNDATION_LEGACY_VERSION}/auth")
def get_foundation_auth_legacy(request: Request):
    return auth_response(str(request.base_url).rstrip("/"))


@router.get(f"/foundation/{FOUNDATION_VERSION}/current-user")
def get_foundation_current_user(user: dict = Depends(get_current_bcf_user)):
    return user


@router.get(f"/foundation/{FOUNDATION_LEGACY_VERSION}/current-user")
def get_foundation_current_user_legacy(user: dict = Depends(get_current_bcf_user)):
    return user
