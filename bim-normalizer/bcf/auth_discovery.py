from fastapi import APIRouter, Request

from bcf.versions import BCF_VERSION, BCF_LEGACY_VERSION

router = APIRouter(tags=["bcf-discovery"])


def _auth_response(base: str):
    # ZOOM ignores http_basic_supported entirely and requires real OAuth2/OIDC
    # (confirmed via M0 testing) — see bcf/oauth.py for the fake shim behind
    # these URLs.
    return {
        "http_basic_supported": True,
        "oauth2_auth_url": f"{base}/bcf-bridge/oauth2/authorize",
        "oauth2_token_url": f"{base}/bcf-bridge/oauth2/token",
        "supported_oauth2_flows": ["authorization_code_grant"],
    }


@router.get(f"/bcf/{BCF_VERSION}/auth")
def get_auth(request: Request):
    return _auth_response(str(request.base_url).rstrip("/"))


@router.get(f"/bcf/{BCF_LEGACY_VERSION}/auth")
def get_auth_legacy(request: Request):
    return _auth_response(str(request.base_url).rstrip("/"))
