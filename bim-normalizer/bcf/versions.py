from fastapi import APIRouter, Request

router = APIRouter(tags=["bcf-discovery"])

BCF_VERSION = "3.0"
# Many real-world clients (e.g. BIMcollab ZOOM) only understand 2.1 — advertise
# both so older clients pick 2.1 and never look at the 3.0 entry.
BCF_LEGACY_VERSION = "2.1"


@router.get("/bcf/versions")
def get_versions(request: Request):
    base = str(request.base_url).rstrip("/")
    return {
        "versions": [
            {
                "version_id": BCF_LEGACY_VERSION,
                "detailed_version": "https://github.com/buildingSMART/BCF-API/tree/release_2_1",
            },
            {
                "api_id": "bcf",
                "version_id": BCF_VERSION,
                "detailed_version": "https://github.com/buildingSMART/BCF-API/tree/release_3_0",
                "api_base_url": f"{base}/bcf/{BCF_VERSION}/",
            },
        ]
    }
