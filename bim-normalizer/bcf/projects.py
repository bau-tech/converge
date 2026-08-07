from fastapi import APIRouter, Depends, HTTPException, Request

from bcf.auth import get_current_bcf_user
from bcf.db import fetch_all, fetch_one
from bcf.versions import is_bcf_v3

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
    # The assignable-user list is filled in live from bcf_users at request
    # time (see _assignable_users() / get_extensions() below) — this placeholder
    # is overwritten on every call, never served as-is. Note the key itself
    # differs by BCF version: 2.1 calls it "user_id_type", 3.0 renamed it to
    # "users" (confirmed against the official BCF-API schemas) — get_extensions()
    # sets whichever key applies for the version the request came in on.
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

# The kinds bcf_extensions actually stores per-project (matches the CHECK
# constraint in bcf/db_schema.py) — also used by the admin panel's
# per-project extensions editor.
EXTENSION_KINDS = ("topic_type", "topic_status", "priority", "topic_label", "stage")


def default_extension_values(kind: str) -> list[str]:
    return list(_DEFAULT_EXTENSIONS.get(kind, []))


@router.get("/current-user")
def get_current_user(user: dict = Depends(get_current_bcf_user)):
    return user


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


def _assignable_users() -> list[str]:
    rows = fetch_all("SELECT email FROM bcf_users ORDER BY email")
    return [r["email"] for r in rows]


def extension_value_lists(project_id: str) -> dict[str, list[str]]:
    # Shared by the BCF-API extensions endpoint below and the admin panel's
    # per-project extensions editor, so both ever agree on the "any custom
    # row switches every kind to DB-only mode" rule (see the comment below).
    rows = fetch_all(
        "SELECT kind, value FROM bcf_extensions WHERE model_id = %s ORDER BY kind, sort_order",
        (project_id,),
    )
    lists = {k: default_extension_values(k) for k in EXTENSION_KINDS}
    if rows:
        # The fixed action arrays aren't user-configurable (no DB rows ever
        # exist for them — see the CHECK constraint in bcf/db_schema.py),
        # only the value-list kinds below are overridden per-project from
        # bcf_extensions.
        for k in EXTENSION_KINDS:
            lists[k] = []
        for r in rows:
            lists.setdefault(r["kind"], []).append(r["value"])
    return lists


@router.get("/projects/{project_id}/extensions")
def get_extensions(project_id: str, request: Request):
    extensions = dict(_DEFAULT_EXTENSIONS)
    extensions.update(extension_value_lists(project_id))
    user_key = "users" if is_bcf_v3(request) else "user_id_type"
    extensions[user_key] = _assignable_users()
    return extensions


# Not part of the open BCF-API spec (absent from both the 2.1 and 3.0 JSON
# schemas) - undocumented, presumably BIMcollab-proprietary. Observed BIMcollab
# ZOOM calling this right after /extensions and /topics, then 404ing and
# refusing to let the user create an issue ("no assignable team members"),
# even though /extensions' user_id_type was correctly populated. Stubbed as
# an empty list so a 404 here can't be why ZOOM blocks issue creation -
# speculative (undocumented endpoint, exact semantics unconfirmed).
@router.get("/projects/{project_id}/conflicts")
def get_conflicts(project_id: str):
    return []
