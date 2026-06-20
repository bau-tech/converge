from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one, execute, execute_returning
from bcf.schemas import TopicCreate, TopicUpdate

router = APIRouter(tags=["bcf-topics"])


def _require_project(project_id: str) -> dict:
    row = fetch_one("SELECT model_id, stream_id FROM bim_models WHERE model_id = %s", (project_id,))
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return row


@router.get("/projects/{project_id}/topics")
def list_topics(project_id: str):
    return fetch_all(
        "SELECT * FROM bcf_topics WHERE model_id = %s ORDER BY creation_date DESC",
        (project_id,),
    )


@router.get("/projects/{project_id}/topics/{topic_guid}")
def get_topic(project_id: str, topic_guid: str):
    row = fetch_one(
        "SELECT * FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found")
    return row


@router.post("/projects/{project_id}/topics", status_code=201)
def create_topic(project_id: str, body: TopicCreate):
    project = _require_project(project_id)
    return execute_returning(
        """
        INSERT INTO bcf_topics (
            model_id, stream_id, title, description, topic_type, topic_status,
            priority, stage, labels, creation_author, due_date, assigned_to, creation_date
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()))
        RETURNING *
        """,
        (
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
        ),
    )


@router.put("/projects/{project_id}/topics/{topic_guid}")
def update_topic(project_id: str, topic_guid: str, body: TopicUpdate):
    existing = get_topic(project_id, topic_guid)
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        return existing
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
    return row


@router.delete("/projects/{project_id}/topics/{topic_guid}", status_code=204)
def delete_topic(project_id: str, topic_guid: str):
    get_topic(project_id, topic_guid)
    execute("DELETE FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid))


@router.get("/projects/{project_id}/topics/{topic_guid}/related_topics")
def list_related_topics(project_id: str, topic_guid: str):
    get_topic(project_id, topic_guid)
    return fetch_all(
        "SELECT related_topic_guid FROM bcf_related_topics WHERE topic_guid = %s", (topic_guid,)
    )


@router.post("/projects/{project_id}/topics/{topic_guid}/related_topics", status_code=201)
def add_related_topic(project_id: str, topic_guid: str, body: dict):
    get_topic(project_id, topic_guid)
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
    get_topic(project_id, topic_guid)
    return fetch_all(
        "SELECT * FROM bcf_document_references WHERE topic_guid = %s", (topic_guid,)
    )


@router.post("/projects/{project_id}/topics/{topic_guid}/document_references", status_code=201)
def add_document_reference(project_id: str, topic_guid: str, body: dict):
    get_topic(project_id, topic_guid)
    return execute_returning(
        """
        INSERT INTO bcf_document_references (topic_guid, document_guid, url, description)
        VALUES (%s, %s, %s, %s) RETURNING *
        """,
        (topic_guid, body.get("document_guid"), body.get("url"), body.get("description")),
    )
