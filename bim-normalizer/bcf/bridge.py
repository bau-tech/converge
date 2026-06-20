from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one, execute

router = APIRouter(tags=["bcf-bridge"], prefix="/bcf-bridge")


@router.get("/projects/resolve")
def resolve_project(stream_id: str):
    row = fetch_one(
        """
        SELECT model_id, branch_name FROM bim_models
        WHERE stream_id = %s ORDER BY ingested_at DESC LIMIT 1
        """,
        (stream_id,),
    )
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="No ingested model found for this stream — ingest it first",
        )
    return {
        "project_id": str(row["model_id"]),
        "stream_id": stream_id,
        "model_name": row["branch_name"],
    }


@router.get("/projects/{project_id}/sync")
def list_sync_records(project_id: str):
    return fetch_all(
        "SELECT speckle_comment_id, topic_guid, direction FROM bcf_speckle_sync WHERE model_id = %s",
        (project_id,),
    )


@router.post("/projects/{project_id}/sync", status_code=201)
def add_sync_record(project_id: str, body: dict):
    execute(
        """
        INSERT INTO bcf_speckle_sync (model_id, speckle_comment_id, topic_guid, direction)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (model_id, speckle_comment_id, direction) DO NOTHING
        """,
        (project_id, body["speckle_comment_id"], body.get("topic_guid"), body["direction"]),
    )
    return {"ok": True}


@router.get("/projects/{project_id}/comment-sync")
def list_comment_sync(project_id: str):
    return fetch_all(
        """
        SELECT cs.comment_guid, cs.speckle_reply_id
        FROM bcf_comment_push_sync cs
        JOIN bcf_comments c ON c.guid = cs.comment_guid
        JOIN bcf_topics t ON t.guid = c.topic_guid
        WHERE t.model_id = %s
        """,
        (project_id,),
    )


@router.post("/projects/{project_id}/comment-sync", status_code=201)
def add_comment_sync(project_id: str, body: dict):
    execute(
        """
        INSERT INTO bcf_comment_push_sync (comment_guid, speckle_reply_id)
        VALUES (%s, %s)
        ON CONFLICT (comment_guid) DO NOTHING
        """,
        (body["comment_guid"], body["speckle_reply_id"]),
    )
    return {"ok": True}
