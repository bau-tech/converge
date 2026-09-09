from fastapi import APIRouter, HTTPException

from bcf.db import fetch_all, fetch_one, execute

router = APIRouter(tags=["bcf-bridge"], prefix="/bcf-bridge")


@router.get("/projects/resolve")
def resolve_project(stream_id: str, branch_name: str | None = None):
    # A Speckle stream_id can carry several models (one per branch), each
    # with its own model_id/bcf_topics — see bcf/projects.py::list_projects,
    # which had to move off "one row per stream_id" for the same reason.
    # When the caller knows which model it wants, branch_name pins the
    # lookup to that (stream_id, branch_name) pair, same as list_projects'
    # DISTINCT ON. Without it we only ever return a single project_id, so we
    # only guess (most-recently-ingested) when the stream is unambiguous
    # (exactly one branch); otherwise resolving silently to "whichever
    # branch happened to sync last" would route issues to the wrong model.
    if branch_name is not None:
        row = fetch_one(
            """
            SELECT model_id, branch_name FROM bim_models
            WHERE stream_id = %s AND branch_name = %s ORDER BY ingested_at DESC LIMIT 1
            """,
            (stream_id, branch_name),
        )
        if row is None:
            raise HTTPException(
                status_code=404,
                detail="No ingested model found for this stream+branch — ingest it first",
            )
        return {
            "project_id": str(row["model_id"]),
            "stream_id": stream_id,
            "model_name": row["branch_name"],
        }

    rows = fetch_all(
        """
        SELECT DISTINCT ON (branch_name) model_id, branch_name FROM bim_models
        WHERE stream_id = %s ORDER BY branch_name, ingested_at DESC
        """,
        (stream_id,),
    )
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No ingested model found for this stream — ingest it first",
        )
    if len(rows) > 1:
        raise HTTPException(
            status_code=409,
            detail=(
                "This stream has multiple ingested models — pass branch_name to "
                f"pick one: {[r['branch_name'] for r in rows]}"
            ),
        )
    row = rows[0]
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
