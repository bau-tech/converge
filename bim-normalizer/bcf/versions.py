from fastapi import APIRouter, Request

router = APIRouter(tags=["bcf-discovery"])

BCF_VERSION = "3.0"
# Many real-world clients (e.g. BIMcollab ZOOM) only understand 2.1 — advertise
# both so older clients pick 2.1 and never look at the 3.0 entry.
BCF_LEGACY_VERSION = "2.1"

# BCF 3.0 is itself an OpenCDE API, and OpenCDE requires every implementation
# to also expose the shared Foundation API (versions/auth/current-user) under
# its own /foundation/{version}/ path — confirmed by a real client (observed
# in production logs) calling GET /foundation/1.0/auth before ever touching
# /bcf/2.1/auth. See bcf/foundation.py for the auth/current-user routes; this
# module owns the version numbers and the /versions payload both APIs share.
FOUNDATION_VERSION = "1.1"
FOUNDATION_LEGACY_VERSION = "1.0"


def build_versions_payload(base: str) -> dict:
    return {
        "versions": [
            {
                "api_id": "foundation",
                "version_id": FOUNDATION_VERSION,
                "detailed_version": "https://github.com/buildingSMART/foundation-API/tree/release_1_1",
                "api_base_url": f"{base}/foundation/{FOUNDATION_VERSION}/",
            },
            {
                "api_id": "bcf",
                "version_id": BCF_LEGACY_VERSION,
                "detailed_version": "https://github.com/buildingSMART/BCF-API/tree/release_2_1",
                "api_base_url": f"{base}/bcf/{BCF_LEGACY_VERSION}/",
            },
            {
                "api_id": "bcf",
                "version_id": BCF_VERSION,
                "detailed_version": "https://github.com/buildingSMART/BCF-API/tree/release_3_0",
                "api_base_url": f"{base}/bcf/{BCF_VERSION}/",
            },
        ]
    }


@router.get("/bcf/versions")
def get_versions(request: Request):
    return build_versions_payload(str(request.base_url).rstrip("/"))


# Per the Foundation API spec, the versions service is always served from
# /foundation/versions regardless of any api_base_url — clients that are
# OpenCDE/Foundation-aware look here first, not under /bcf/.
@router.get("/foundation/versions")
def get_foundation_versions(request: Request):
    return build_versions_payload(str(request.base_url).rstrip("/"))
