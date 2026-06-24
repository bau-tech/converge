from fastapi import APIRouter, Request

from bcf.versions import BCF_VERSION, BCF_LEGACY_VERSION

router = APIRouter(tags=["bcf-discovery"])


def auth_response(base: str):
    # ZOOM ignores http_basic_supported entirely and requires real OAuth2/OIDC
    # (confirmed via M0 testing). bcf/auth.py *does* honor real Basic auth —
    # but advertising it here as supported is actively harmful: Solibri's BCF
    # connector reads http_basic_supported: true and tries to build a
    # BasicAuthentication credential, with no UI for configuring a
    # username/password anywhere in its "add server" dialog. With nothing
    # configured it passes null and crashes with an NPE in Google's HTTP
    # client (com.google.api.client.http.BasicAuthentication.<init>) before
    # ever falling back to OAuth2 (confirmed via Solibri's own client log).
    # Advertising false makes it skip straight to the OAuth2 flow below,
    # which is the one proven working (BIMcollab uses it successfully).
    return {
        "http_basic_supported": False,
        "oauth2_auth_url": f"{base}/bcf-bridge/oauth2/authorize",
        "oauth2_token_url": f"{base}/bcf-bridge/oauth2/token",
        "oauth2_dynamic_client_reg_url": f"{base}/bcf-bridge/oauth2/register",
        "supported_oauth2_flows": ["authorization_code_grant"],
    }


@router.get(f"/bcf/{BCF_VERSION}/auth")
def get_auth(request: Request):
    return auth_response(str(request.base_url).rstrip("/"))


@router.get(f"/bcf/{BCF_LEGACY_VERSION}/auth")
def get_auth_legacy(request: Request):
    return auth_response(str(request.base_url).rstrip("/"))
