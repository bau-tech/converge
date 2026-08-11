import base64
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from bcf.bcfxml import MAX_ZIP_MEMBER_BYTES
from bcf.db import fetch_all, fetch_one, execute, execute_returning
from bcf.schemas import ViewpointCreate

router = APIRouter(tags=["bcf-viewpoints"])


def _require_topic(project_id: str, topic_guid: str) -> None:
    row = fetch_one(
        "SELECT guid FROM bcf_topics WHERE model_id = %s AND guid = %s", (project_id, topic_guid)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Topic not found")


def _components_for(model_id: str, viewpoint_guid: str) -> dict:
    # Resolves each ifc_guid (= application_id, the native source-app GUID) to
    # the dashboard's speckle_id server-side, so any consumer of this endpoint
    # gets a ready-to-use reference instead of re-deriving it client-side.
    # LATERAL ... LIMIT 1 picks one arbitrary match if application_id is
    # duplicated within the model (a known, separately-tracked data-quality
    # issue) rather than fanning out extra rows or erroring.
    rows = fetch_all(
        """
        SELECT vpc.ifc_guid, vpc.component_type, vpc.color, be.speckle_id
        FROM bcf_viewpoint_components vpc
        LEFT JOIN LATERAL (
            SELECT speckle_id FROM bim_elements
            WHERE model_id = %s AND application_id = vpc.ifc_guid
            LIMIT 1
        ) be ON true
        WHERE vpc.viewpoint_guid = %s
        """,
        (model_id, viewpoint_guid),
    )
    return {
        "selection": [
            {"ifc_guid": r["ifc_guid"], "speckle_id": r["speckle_id"]}
            for r in rows
            if r["component_type"] == "selection"
        ],
        "visibility_exceptions": [
            {"ifc_guid": r["ifc_guid"], "speckle_id": r["speckle_id"]}
            for r in rows
            if r["component_type"] == "visibility_exception"
        ],
        "coloring": [
            {"ifc_guid": r["ifc_guid"], "color": r["color"], "speckle_id": r["speckle_id"]}
            for r in rows
            if r["component_type"] == "coloring"
        ],
    }


def _viewpoint_with_components(model_id: str, row: dict) -> dict:
    return {**row, **_components_for(model_id, str(row["guid"]))}


@router.get("/projects/{project_id}/topics/{topic_guid}/viewpoints")
def list_viewpoints(project_id: str, topic_guid: str):
    _require_topic(project_id, topic_guid)
    rows = fetch_all(
        """
        SELECT guid, topic_guid, "index", is_orthogonal, camera_view_point, camera_direction,
               camera_up_vector, field_of_view, view_to_world_scale, clipping_planes,
               default_visibility, snapshot_format, created_at
        FROM bcf_viewpoints WHERE topic_guid = %s ORDER BY created_at
        """,
        (topic_guid,),
    )
    return [_viewpoint_with_components(project_id, r) for r in rows]


@router.get("/projects/{project_id}/topics/{topic_guid}/viewpoints/{viewpoint_guid}")
def get_viewpoint(project_id: str, topic_guid: str, viewpoint_guid: str):
    _require_topic(project_id, topic_guid)
    row = fetch_one(
        """
        SELECT guid, topic_guid, "index", is_orthogonal, camera_view_point, camera_direction,
               camera_up_vector, field_of_view, view_to_world_scale, clipping_planes,
               default_visibility, snapshot_format, created_at
        FROM bcf_viewpoints WHERE topic_guid = %s AND guid = %s
        """,
        (topic_guid, viewpoint_guid),
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Viewpoint not found")
    return _viewpoint_with_components(project_id, row)


@router.get("/projects/{project_id}/topics/{topic_guid}/viewpoints/{viewpoint_guid}/snapshot")
def get_snapshot(project_id: str, topic_guid: str, viewpoint_guid: str):
    _require_topic(project_id, topic_guid)
    row = fetch_one(
        "SELECT snapshot_data, snapshot_format FROM bcf_viewpoints WHERE topic_guid = %s AND guid = %s",
        (topic_guid, viewpoint_guid),
    )
    if row is None or row["snapshot_data"] is None:
        raise HTTPException(status_code=404, detail="No snapshot for this viewpoint")
    media_type = f"image/{row['snapshot_format'] or 'png'}"
    return Response(content=bytes(row["snapshot_data"]), media_type=media_type)


@router.post("/projects/{project_id}/topics/{topic_guid}/viewpoints", status_code=201)
def create_viewpoint(project_id: str, topic_guid: str, body: ViewpointCreate):
    _require_topic(project_id, topic_guid)

    snapshot_data = None
    snapshot_format = None
    if body.snapshot_base64:
        snapshot_data = base64.b64decode(body.snapshot_base64)
        # Same cap bcfxml.py's .bcfzip import already applies per zip member
        # (a viewpoint snapshot there is the same kind of artifact as this
        # one) — this REST path had no equivalent size check at all before,
        # letting a caller push an arbitrarily large payload straight into
        # Postgres per viewpoint.
        if len(snapshot_data) > MAX_ZIP_MEMBER_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Snapshot too large ({len(snapshot_data)} bytes, max {MAX_ZIP_MEMBER_BYTES})",
            )
        snapshot_format = "png"

    row = execute_returning(
        """
        INSERT INTO bcf_viewpoints (
            topic_guid, is_orthogonal, camera_view_point, camera_direction, camera_up_vector,
            field_of_view, view_to_world_scale, clipping_planes, default_visibility,
            snapshot_format, snapshot_data
        ) VALUES (%s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s)
        RETURNING guid, topic_guid, "index", is_orthogonal, camera_view_point, camera_direction,
                  camera_up_vector, field_of_view, view_to_world_scale, clipping_planes,
                  default_visibility, snapshot_format, created_at
        """,
        (
            topic_guid,
            body.is_orthogonal,
            json.dumps(body.camera_view_point.model_dump()) if body.camera_view_point else None,
            json.dumps(body.camera_direction.model_dump()) if body.camera_direction else None,
            json.dumps(body.camera_up_vector.model_dump()) if body.camera_up_vector else None,
            body.field_of_view,
            body.view_to_world_scale,
            json.dumps([cp.model_dump() for cp in body.clipping_planes]),
            body.default_visibility,
            snapshot_format,
            snapshot_data,
        ),
    )

    viewpoint_guid = str(row["guid"])
    for ifc_guid in body.selection:
        execute(
            """
            INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type)
            VALUES (%s, %s, 'selection') ON CONFLICT DO NOTHING
            """,
            (viewpoint_guid, ifc_guid),
        )
    for ifc_guid in body.visibility_exceptions:
        execute(
            """
            INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type)
            VALUES (%s, %s, 'visibility_exception') ON CONFLICT DO NOTHING
            """,
            (viewpoint_guid, ifc_guid),
        )
    for item in body.coloring:
        execute(
            """
            INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type, color)
            VALUES (%s, %s, 'coloring', %s) ON CONFLICT DO NOTHING
            """,
            (viewpoint_guid, item["ifc_guid"], item.get("color")),
        )

    return _viewpoint_with_components(project_id, row)


@router.delete(
    "/projects/{project_id}/topics/{topic_guid}/viewpoints/{viewpoint_guid}", status_code=204
)
def delete_viewpoint(project_id: str, topic_guid: str, viewpoint_guid: str):
    _require_topic(project_id, topic_guid)
    execute(
        "DELETE FROM bcf_viewpoints WHERE topic_guid = %s AND guid = %s",
        (topic_guid, viewpoint_guid),
    )
