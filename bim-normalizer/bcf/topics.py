from fastapi import APIRouter, HTTPException, Request

from bcf.db import fetch_all, fetch_one, execute, execute_returning
from bcf.schemas import TopicCreate, TopicUpdate
from bcf.versions import is_bcf_v3

router = APIRouter(tags=["bcf-topics"])


def _require_project(project_id: str) -> dict:
    row = fetch_one("SELECT model_id, stream_id FROM bim_models WHERE model_id = %s", (project_id,))
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


# BCF 3.0's topic_GET schema requires a "server_assigned_id" string field
# that doesn't exist in 2.1 at all. We have no dedicated column for it, but
# the existing (otherwise-unused) "index" integer column already gets a
# per-project sequential value on create (see create_topic below), so we
# reuse it as the source value — just exposed under the extra key only when
# the request came in on /bcf/3.0/.
def _with_server_assigned_id(row: dict, request: Request) -> dict:
    if row is not None and is_bcf_v3(request):
        row = dict(row)
        row["server_assigned_id"] = str(row["index"])
    return row


@router.get("/projects/{project_id}/topics")
def list_topics(project_id: str, request: Request):
    rows = fetch_all(
        "SELECT * FROM bcf_topics WHERE model_id = %s ORDER BY creation_date DESC",
        (project_id,),
    )
    return [_with_server_assigned_id(r, request) for r in rows]


def _require_topic(project_id: str, topic_guid: str) -> dict:
    row = fetch_one(
        "SELECT * FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found")
    return row


@router.get("/projects/{project_id}/topics/{topic_guid}")
def get_topic(project_id: str, topic_guid: str, request: Request):
    return _with_server_assigned_id(_require_topic(project_id, topic_guid), request)


@router.post("/projects/{project_id}/topics", status_code=201)
def create_topic(project_id: str, body: TopicCreate, request: Request):
    project = _require_project(project_id)
    row = execute_returning(
        """
        -- pg_advisory_xact_lock serializes index assignment per model_id (released
        -- automatically on commit) — without it, two concurrent creates can read the
        -- same MAX("index") and collide, which BCF 3.0 exposes as a duplicate
        -- server_assigned_id (see _with_server_assigned_id below).
        SELECT pg_advisory_xact_lock(hashtext(%s));
        INSERT INTO bcf_topics (
            model_id, stream_id, title, description, topic_type, topic_status,
            priority, stage, labels, creation_author, due_date, assigned_to, creation_date, "index"
        ) VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()),
            COALESCE((SELECT MAX("index") FROM bcf_topics WHERE model_id = %s), 0) + 1
        )
        RETURNING *
        """,
        (
            project_id,
            project_id,
            project["stream_id"],
            body.title,
            body.description,
            body.topic_type,
            body.topic_status,
            body.priority,
            body.stage,
            body.labels,
            body.creation_author,
            body.due_date,
            body.assigned_to,
            body.creation_date,
            project_id,
        ),
    )
    return _with_server_assigned_id(row, request)


@router.put("/projects/{project_id}/topics/{topic_guid}")
def update_topic(project_id: str, topic_guid: str, body: TopicUpdate, request: Request):
    existing = _require_topic(project_id, topic_guid)
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        return _with_server_assigned_id(existing, request)
    set_clause = ", ".join(f"{k} = %s" for k in updates)
    values = list(updates.values())
    row = execute_returning(
        f"""
        UPDATE bcf_topics SET {set_clause}, modified_date = NOW()
        WHERE model_id = %s AND guid = %s
        RETURNING *
        """,
        (*values, project_id, topic_guid),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found")
    return _with_server_assigned_id(row, request)


@router.delete("/projects/{project_id}/topics/{topic_guid}", status_code=204)
def delete_topic(project_id: str, topic_guid: str):
    _require_topic(project_id, topic_guid)
    execute("DELETE FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid))


@router.get("/projects/{project_id}/topics/{topic_guid}/related_topics")
def list_related_topics(project_id: str, topic_guid: str):
    _require_topic(project_id, topic_guid)
    return fetch_all(
        "SELECT related_topic_guid FROM bcf_related_topics WHERE topic_guid = %s", (topic_guid,)
    )


@router.post("/projects/{project_id}/topics/{topic_guid}/related_topics", status_code=201)
def add_related_topic(project_id: str, topic_guid: str, body: dict):
    _require_topic(project_id, topic_guid)
    related_guid = body["related_topic_guid"]
    execute(
        """
        INSERT INTO bcf_related_topics (topic_guid, related_topic_guid)
        VALUES (%s, %s) ON CONFLICT DO NOTHING
        """,
        (topic_guid, related_guid),
    )
    return {"related_topic_guid": related_guid}


@router.get("/projects/{project_id}/topics/{topic_guid}/document_references")
def list_document_references(project_id: str, topic_guid: str):
    _require_topic(project_id, topic_guid)
    return fetch_all(
        "SELECT * FROM bcf_document_references WHERE topic_guid = %s", (topic_guid,)
    )


@router.post("/projects/{project_id}/topics/{topic_guid}/document_references", status_code=201)
def add_document_reference(project_id: str, topic_guid: str, body: dict):
    _require_topic(project_id, topic_guid)
    return execute_returning(
        """
        INSERT INTO bcf_document_references (topic_guid, document_guid, url, description)
        VALUES (%s, %s, %s, %s) RETURNING *
        """,
        (topic_guid, body.get("document_guid"), body.get("url"), body.get("description")),
    )
