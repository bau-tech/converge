from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one
from bcf.oauth import current_user, FAKE_USER_EMAIL

router = APIRouter(tags=["bcf-projects"])

# Every project gets the same fixed permission set — there's no per-user
# access control in this fake-identity setup, but BCF 2.1 clients (confirmed:
# BIMcollab ZOOM) expect this field to be present on every Project object or
# they fail client-side when "opening" a project from an already-fetched list.
_AUTHORIZATION = {"project_actions": ["createTopic", "createDocument", "update"]}

# Defaults used when a project has no bcf_extensions rows of its own yet.
# Per the BCF 2.1 spec's GET .../extensions example, this also needs to list
# the permitted project/topic/comment *actions* — clients (confirmed:
# BIMcollab ZOOM and the Tekla BCF Manager, which share the same underlying
# connector) appear to crash client-side when "opening" a project if these
# action arrays are missing, since they likely drive which UI buttons render.
_DEFAULT_EXTENSIONS = {
    "topic_type": ["Issue", "Clash", "Request", "Remark"],
    "topic_status": ["Open", "In Progress", "Closed"],
    "priority": ["Low", "Normal", "High", "Critical"],
    "topic_label": [],
    "snippet_type": [],
    "stage": [],
    "user_id_type": [FAKE_USER_EMAIL],
    "project_actions": ["update", "createTopic", "createDocument"],
    "topic_actions": [
        "update",
        "updateBimSnippet",
        "updateRelatedTopics",
        "updateDocumentReferences",
        "updateFiles",
        "createComment",
        "createViewpoint",
    ],
    "comment_actions": ["update"],
}


@router.get("/current-user")
def get_current_user():
    return current_user()


@router.get("/projects")
def list_projects():
    rows = fetch_all(
        """
        SELECT DISTINCT ON (stream_id) model_id, stream_id, branch_name
        FROM bim_models
        ORDER BY stream_id, ingested_at DESC
        """
    )
    return [
        {
            "project_id": str(r["model_id"]),
            "name": r["branch_name"] or r["stream_id"],
            "authorization": _AUTHORIZATION,
        }
        for r in rows
    ]


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    row = fetch_one(
        "SELECT model_id, stream_id, branch_name FROM bim_models WHERE model_id = %s",
        (project_id,),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "project_id": str(row["model_id"]),
        "name": row["branch_name"] or row["stream_id"],
        "authorization": _AUTHORIZATION,
    }


@router.get("/projects/{project_id}/extensions")
def get_extensions(project_id: str):
    rows = fetch_all(
        "SELECT kind, value FROM bcf_extensions WHERE model_id = %s ORDER BY kind, sort_order",
        (project_id,),
    )
    if not rows:
        return _DEFAULT_EXTENSIONS
    # The fixed action arrays aren't user-configurable (no DB rows ever exist
    # for them — see the CHECK constraint in bcf/db_schema.py), only the
    # value-list kinds below are overridden per-project from bcf_extensions.
    extensions = dict(_DEFAULT_EXTENSIONS)
    for k in ("topic_type", "topic_status", "priority", "topic_label", "stage"):
        extensions[k] = []
    for r in rows:
        extensions.setdefault(r["kind"], []).append(r["value"])
    return extensions
