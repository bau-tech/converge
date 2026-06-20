from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one, execute, execute_returning
from bcf.schemas import CommentCreate, CommentUpdate

router = APIRouter(tags=["bcf-comments"])


def _require_topic(project_id: str, topic_guid: str) -> None:
    row = fetch_one(
        "SELECT guid FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found")


@router.get("/projects/{project_id}/topics/{topic_guid}/comments")
def list_comments(project_id: str, topic_guid: str):
    _require_topic(project_id, topic_guid)
    return fetch_all(
        "SELECT * FROM bcf_comments WHERE topic_guid = %s ORDER BY date", (topic_guid,)
    )


@router.get("/projects/{project_id}/topics/{topic_guid}/comments/{comment_guid}")
def get_comment(project_id: str, topic_guid: str, comment_guid: str):
    _require_topic(project_id, topic_guid)
    row = fetch_one(
        "SELECT * FROM bcf_comments WHERE topic_guid = %s AND guid = %s",
        (topic_guid, comment_guid),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return row


@router.post("/projects/{project_id}/topics/{topic_guid}/comments", status_code=201)
def create_comment(project_id: str, topic_guid: str, body: CommentCreate):
    _require_topic(project_id, topic_guid)
    if body.viewpoint_guid:
        vp = fetch_one(
            "SELECT guid FROM bcf_viewpoints WHERE guid = %s AND topic_guid = %s",
            (body.viewpoint_guid, topic_guid),
        )
        if vp is None:
            raise HTTPException(status_code=400, detail="viewpoint_guid does not exist on this topic")
    return execute_returning(
        """
        INSERT INTO bcf_comments (topic_guid, viewpoint_guid, comment, author, date)
        VALUES (%s, %s, %s, %s, COALESCE(%s::timestamptz, NOW())) RETURNING *
        """,
        (topic_guid, body.viewpoint_guid, body.comment, body.author, body.date),
    )


@router.put("/projects/{project_id}/topics/{topic_guid}/comments/{comment_guid}")
def update_comment(project_id: str, topic_guid: str, comment_guid: str, body: CommentUpdate):
    _require_topic(project_id, topic_guid)
    row = execute_returning(
        """
        UPDATE bcf_comments SET comment = %s, modified_author = %s, modified_date = NOW()
        WHERE topic_guid = %s AND guid = %s
        RETURNING *
        """,
        (body.comment, body.modified_author, topic_guid, comment_guid),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Comment not found")
    return row


@router.delete("/projects/{project_id}/topics/{topic_guid}/comments/{comment_guid}", status_code=204)
def delete_comment(project_id: str, topic_guid: str, comment_guid: str):
    _require_topic(project_id, topic_guid)
    execute(
        "DELETE FROM bcf_comments WHERE topic_guid = %s AND guid = %s", (topic_guid, comment_guid)
    )
