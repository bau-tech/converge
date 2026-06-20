"""
BCF-XML (.bcfzip) export/import
=================================
Implements the file-based BCF interop format (buildingSMART BCF-XML, see
https://github.com/buildingSMART/BCF-XML) — a zip archive with one folder
per topic (markup.bcf + viewpoint.bcfv + snapshot.png) plus a root
bcf.version file. This is the universally-supported import/export mechanism
every major BIM tool implements, unlike the live REST connection (see the
plan doc's M0/M1 notes on why that path was abandoned).

Simplification: only the first viewpoint per topic is exported/imported.
Multi-viewpoint topics are rare in practice and not needed for our own
dashboard's create-one-viewpoint-per-topic flow.
"""

import io
import json
import zipfile
import xml.etree.ElementTree as ET
from datetime import timezone

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response

from bcf.db import fetch_all, fetch_one, execute, execute_returning

router = APIRouter(tags=["bcf-xml"], prefix="/bcf-bridge")

BCF_FILE_VERSION = "2.1"


def _el(parent, tag, text=None, **attrib):
    e = ET.SubElement(parent, tag, **{k: str(v) for k, v in attrib.items() if v is not None})
    if text is not None:
        e.text = str(text)
    return e


def _vec_el(parent, tag, vec: dict):
    e = ET.SubElement(parent, tag)
    _el(e, "X", vec.get("x", 0))
    _el(e, "Y", vec.get("y", 0))
    _el(e, "Z", vec.get("z", 0))
    return e


def _vec_from_el(el) -> dict:
    return {
        "x": float(el.findtext("X", "0")),
        "y": float(el.findtext("Y", "0")),
        "z": float(el.findtext("Z", "0")),
    }


def _iso(dt) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    return dt.astimezone(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def _build_markup_xml(
    topic: dict, comments: list[dict], viewpoint_guid: str | None, has_snapshot: bool = False
) -> bytes:
    markup = ET.Element("Markup")

    topic_el = ET.SubElement(
        markup,
        "Topic",
        Guid=str(topic["guid"]),
        TopicType=topic.get("topic_type") or "",
        TopicStatus=topic.get("topic_status") or "",
    )
    # Element order below must match the BCF 2.1 markup.xsd Topic complexType's
    # xs:sequence exactly — strict validators (confirmed: BIMcollab/Tekla's
    # import) silently drop the topic's viewpoint if children are out of order.
    _el(topic_el, "Title", topic["title"])
    if topic.get("priority"):
        _el(topic_el, "Priority", topic["priority"])
    for label in topic.get("labels") or []:
        _el(topic_el, "Labels", label)
    _el(topic_el, "CreationDate", _iso(topic["creation_date"]))
    _el(topic_el, "CreationAuthor", topic["creation_author"])
    # ModifiedDate/Author are optional per spec, but BIMcollab displays its own
    # placeholder date (01-01-2001) rather than leaving the field blank when
    # they're absent — defaulting to the creation values reads better there.
    _el(topic_el, "ModifiedDate", _iso(topic.get("modified_date") or topic["creation_date"]))
    _el(topic_el, "ModifiedAuthor", topic.get("modified_author") or topic["creation_author"])
    if topic.get("due_date"):
        _el(topic_el, "DueDate", _iso(topic["due_date"]))
    if topic.get("assigned_to"):
        _el(topic_el, "AssignedTo", topic["assigned_to"])
    if topic.get("stage"):
        _el(topic_el, "Stage", topic["stage"])
    if topic.get("description"):
        _el(topic_el, "Description", topic["description"])

    # Markup's own sequence is Header?, Topic, Comment*, Viewpoints* — Comments
    # must be emitted before Viewpoints here too.
    for c in comments:
        comment_el = ET.SubElement(markup, "Comment", Guid=str(c["guid"]))
        _el(comment_el, "Date", _iso(c["date"]))
        _el(comment_el, "Author", c["author"])
        _el(comment_el, "Comment", c["comment"])
        if c.get("viewpoint_guid"):
            ET.SubElement(comment_el, "Viewpoint", Guid=str(c["viewpoint_guid"]))
        if c.get("modified_date"):
            _el(comment_el, "ModifiedDate", _iso(c["modified_date"]))
        if c.get("modified_author"):
            _el(comment_el, "ModifiedAuthor", c["modified_author"])

    if viewpoint_guid:
        # Per markup.xsd, Guid is the only attribute on Viewpoints — Viewpoint
        # and Snapshot are child elements with text content, not attributes.
        viewpoints_el = ET.SubElement(markup, "Viewpoints", Guid=viewpoint_guid)
        _el(viewpoints_el, "Viewpoint", "viewpoint.bcfv")
        if has_snapshot:
            _el(viewpoints_el, "Snapshot", "snapshot.png")

    return ET.tostring(markup, encoding="utf-8", xml_declaration=True)


def _build_viewpoint_xml(viewpoint: dict, components: dict) -> bytes:
    root = ET.Element("VisualizationInfo", Guid=str(viewpoint["guid"]))

    components_el = ET.SubElement(root, "Components")
    if components["selection"]:
        sel_el = ET.SubElement(components_el, "Selection")
        for guid in components["selection"]:
            ET.SubElement(sel_el, "Component", IfcGuid=guid)
    vis_el = ET.SubElement(
        components_el, "Visibility", DefaultVisibility=str(viewpoint.get("default_visibility", True)).lower()
    )
    if components["visibility_exceptions"]:
        exc_el = ET.SubElement(vis_el, "Exceptions")
        for guid in components["visibility_exceptions"]:
            ET.SubElement(exc_el, "Component", IfcGuid=guid)
    if components["coloring"]:
        col_el = ET.SubElement(components_el, "Coloring")
        for item in components["coloring"]:
            color_el = ET.SubElement(col_el, "Color", Color=item.get("color") or "FFFFFF")
            ET.SubElement(color_el, "Component", IfcGuid=item["ifc_guid"])

    if viewpoint.get("camera_view_point"):
        tag = "OrthogonalCamera" if viewpoint.get("is_orthogonal") else "PerspectiveCamera"
        cam_el = ET.SubElement(root, tag)
        _vec_el(cam_el, "CameraViewPoint", viewpoint["camera_view_point"])
        _vec_el(cam_el, "CameraDirection", viewpoint["camera_direction"] or {"x": 0, "y": 0, "z": -1})
        _vec_el(cam_el, "CameraUpVector", viewpoint["camera_up_vector"] or {"x": 0, "y": 1, "z": 0})
        if viewpoint.get("is_orthogonal"):
            _el(cam_el, "ViewToWorldScale", viewpoint.get("view_to_world_scale") or 1.0)
        else:
            _el(cam_el, "FieldOfView", viewpoint.get("field_of_view") or 60.0)

    if viewpoint.get("clipping_planes"):
        cp_root = ET.SubElement(root, "ClippingPlanes")
        for cp in viewpoint["clipping_planes"]:
            cp_el = ET.SubElement(cp_root, "ClippingPlane")
            _vec_el(cp_el, "Location", cp["location"])
            _vec_el(cp_el, "Direction", cp["direction"])

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build_bcfzip(project_id: str) -> bytes:
    topics = fetch_all("SELECT * FROM bcf_topics WHERE model_id = %s", (project_id,))
    if not topics:
        raise HTTPException(status_code=404, detail="No topics to export for this project")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        version_xml = ET.Element("Version", VersionId=BCF_FILE_VERSION)
        _el(version_xml, "DetailedVersion", BCF_FILE_VERSION)
        zf.writestr("bcf.version", ET.tostring(version_xml, encoding="utf-8", xml_declaration=True))

        for topic in topics:
            guid = str(topic["guid"])
            comments = fetch_all(
                "SELECT * FROM bcf_comments WHERE topic_guid = %s ORDER BY date", (guid,)
            )
            viewpoint = fetch_one(
                """
                SELECT guid, "index", is_orthogonal, camera_view_point, camera_direction,
                       camera_up_vector, field_of_view, view_to_world_scale, clipping_planes,
                       default_visibility, snapshot_data, snapshot_format
                FROM bcf_viewpoints WHERE topic_guid = %s ORDER BY created_at LIMIT 1
                """,
                (guid,),
            )

            zf.writestr(
                f"{guid}/markup.bcf",
                _build_markup_xml(
                    topic,
                    comments,
                    str(viewpoint["guid"]) if viewpoint is not None else None,
                    has_snapshot=bool(viewpoint and viewpoint.get("snapshot_data")),
                ),
            )
            if viewpoint is not None:
                components = _components_for_export(str(viewpoint["guid"]))
                zf.writestr(f"{guid}/viewpoint.bcfv", _build_viewpoint_xml(viewpoint, components))
                if viewpoint.get("snapshot_data"):
                    zf.writestr(f"{guid}/snapshot.png", bytes(viewpoint["snapshot_data"]))

    return buf.getvalue()


def _components_for_export(viewpoint_guid: str) -> dict:
    rows = fetch_all(
        "SELECT ifc_guid, component_type, color FROM bcf_viewpoint_components WHERE viewpoint_guid = %s",
        (viewpoint_guid,),
    )
    return {
        "selection": [r["ifc_guid"] for r in rows if r["component_type"] == "selection"],
        "visibility_exceptions": [
            r["ifc_guid"] for r in rows if r["component_type"] == "visibility_exception"
        ],
        "coloring": [
            {"ifc_guid": r["ifc_guid"], "color": r["color"]}
            for r in rows
            if r["component_type"] == "coloring"
        ],
    }


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------

def _parse_markup(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)
    topic_el = root.find("Topic")
    if topic_el is None:
        raise ValueError("markup.bcf has no <Topic>")

    labels = [e.text for e in topic_el.findall("Labels") if e.text]
    topic = {
        "title": topic_el.findtext("Title") or "(untitled)",
        "description": topic_el.findtext("Description"),
        "topic_type": topic_el.get("TopicType") or None,
        "topic_status": topic_el.get("TopicStatus") or None,
        "priority": topic_el.findtext("Priority"),
        "stage": topic_el.findtext("Stage"),
        "labels": labels,
        "creation_author": topic_el.findtext("CreationAuthor") or "imported",
        "due_date": topic_el.findtext("DueDate"),
        "assigned_to": topic_el.findtext("AssignedTo"),
    }

    comments = []
    for c_el in root.findall("Comment"):
        comments.append(
            {
                "comment": c_el.findtext("Comment") or "",
                "author": c_el.findtext("Author") or "imported",
            }
        )

    # Per markup.xsd, Viewpoint/Snapshot are child elements of Viewpoints, not
    # attributes — read the actual referenced filenames rather than assuming
    # the "viewpoint.bcfv"/"snapshot.png" convention (which not every tool follows).
    viewpoints_el = root.find("Viewpoints")
    viewpoint_file = viewpoints_el.findtext("Viewpoint") if viewpoints_el is not None else None
    snapshot_file = viewpoints_el.findtext("Snapshot") if viewpoints_el is not None else None

    return {
        "topic": topic,
        "comments": comments,
        "viewpoint_file": viewpoint_file,
        "snapshot_file": snapshot_file,
    }


def _parse_viewpoint(xml_bytes: bytes) -> dict:
    root = ET.fromstring(xml_bytes)

    selection, visibility_exceptions, coloring = [], [], []
    components_el = root.find("Components")
    if components_el is not None:
        sel_el = components_el.find("Selection")
        if sel_el is not None:
            selection = [c.get("IfcGuid") for c in sel_el.findall("Component")]
        vis_el = components_el.find("Visibility")
        if vis_el is not None:
            exc_el = vis_el.find("Exceptions")
            if exc_el is not None:
                visibility_exceptions = [c.get("IfcGuid") for c in exc_el.findall("Component")]
        col_el = components_el.find("Coloring")
        if col_el is not None:
            for color_el in col_el.findall("Color"):
                for comp_el in color_el.findall("Component"):
                    coloring.append({"ifc_guid": comp_el.get("IfcGuid"), "color": color_el.get("Color")})

    is_orthogonal = root.find("OrthogonalCamera") is not None
    cam_el = root.find("OrthogonalCamera") if is_orthogonal else root.find("PerspectiveCamera")
    camera = {}
    if cam_el is not None:
        camera["camera_view_point"] = _vec_from_el(cam_el.find("CameraViewPoint"))
        camera["camera_direction"] = _vec_from_el(cam_el.find("CameraDirection"))
        camera["camera_up_vector"] = _vec_from_el(cam_el.find("CameraUpVector"))
        if is_orthogonal:
            camera["view_to_world_scale"] = float(cam_el.findtext("ViewToWorldScale", "1"))
        else:
            camera["field_of_view"] = float(cam_el.findtext("FieldOfView", "60"))

    clipping_planes = []
    cp_root = root.find("ClippingPlanes")
    if cp_root is not None:
        for cp_el in cp_root.findall("ClippingPlane"):
            clipping_planes.append(
                {
                    "location": _vec_from_el(cp_el.find("Location")),
                    "direction": _vec_from_el(cp_el.find("Direction")),
                }
            )

    return {
        "is_orthogonal": is_orthogonal,
        "selection": selection,
        "visibility_exceptions": visibility_exceptions,
        "coloring": coloring,
        "clipping_planes": clipping_planes,
        **camera,
    }


def import_bcfzip(project_id: str, file_bytes: bytes) -> list[dict]:
    project = fetch_one("SELECT model_id, stream_id FROM bim_models WHERE model_id = %s", (project_id,))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    created_topics = []
    with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
        topic_folders = sorted({n.split("/")[0] for n in zf.namelist() if "/" in n})
        for folder in topic_folders:
            markup_path = f"{folder}/markup.bcf"
            if markup_path not in zf.namelist():
                continue
            parsed = _parse_markup(zf.read(markup_path))

            topic_row = execute_returning(
                """
                INSERT INTO bcf_topics (
                    model_id, stream_id, title, description, topic_type, topic_status,
                    priority, stage, labels, creation_author, due_date, assigned_to
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    project_id,
                    project["stream_id"],
                    parsed["topic"]["title"],
                    parsed["topic"]["description"],
                    parsed["topic"]["topic_type"],
                    parsed["topic"]["topic_status"],
                    parsed["topic"]["priority"],
                    parsed["topic"]["stage"],
                    parsed["topic"]["labels"],
                    parsed["topic"]["creation_author"],
                    parsed["topic"]["due_date"],
                    parsed["topic"]["assigned_to"],
                ),
            )
            topic_guid = str(topic_row["guid"])

            for c in parsed["comments"]:
                execute(
                    "INSERT INTO bcf_comments (topic_guid, comment, author) VALUES (%s, %s, %s)",
                    (topic_guid, c["comment"], c["author"]),
                )

            vp_filename = parsed.get("viewpoint_file") or "viewpoint.bcfv"
            vp_path = f"{folder}/{vp_filename}"
            if vp_path in zf.namelist():
                vp = _parse_viewpoint(zf.read(vp_path))
                snapshot_filename = parsed.get("snapshot_file") or "snapshot.png"
                snapshot_path = f"{folder}/{snapshot_filename}"
                snapshot_data = zf.read(snapshot_path) if snapshot_path in zf.namelist() else None

                vp_row = execute_returning(
                    """
                    INSERT INTO bcf_viewpoints (
                        topic_guid, is_orthogonal, camera_view_point, camera_direction,
                        camera_up_vector, field_of_view, view_to_world_scale, clipping_planes,
                        snapshot_format, snapshot_data
                    ) VALUES (%s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s, %s, %s::jsonb, %s, %s)
                    RETURNING guid
                    """,
                    (
                        topic_guid,
                        vp["is_orthogonal"],
                        json.dumps(vp["camera_view_point"]) if vp.get("camera_view_point") else None,
                        json.dumps(vp["camera_direction"]) if vp.get("camera_direction") else None,
                        json.dumps(vp["camera_up_vector"]) if vp.get("camera_up_vector") else None,
                        vp.get("field_of_view"),
                        vp.get("view_to_world_scale"),
                        json.dumps(vp.get("clipping_planes", [])),
                        "png" if snapshot_data else None,
                        snapshot_data,
                    ),
                )
                vp_guid = str(vp_row["guid"])
                for ifc_guid in vp["selection"]:
                    execute(
                        """
                        INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type)
                        VALUES (%s, %s, 'selection') ON CONFLICT DO NOTHING
                        """,
                        (vp_guid, ifc_guid),
                    )
                for ifc_guid in vp["visibility_exceptions"]:
                    execute(
                        """
                        INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type)
                        VALUES (%s, %s, 'visibility_exception') ON CONFLICT DO NOTHING
                        """,
                        (vp_guid, ifc_guid),
                    )
                for item in vp["coloring"]:
                    execute(
                        """
                        INSERT INTO bcf_viewpoint_components (viewpoint_guid, ifc_guid, component_type, color)
                        VALUES (%s, %s, 'coloring', %s) ON CONFLICT DO NOTHING
                        """,
                        (vp_guid, item["ifc_guid"], item.get("color")),
                    )

            created_topics.append(topic_row)

    return created_topics


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

@router.get("/projects/{project_id}/export")
def export_project(project_id: str):
    data = build_bcfzip(project_id)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{project_id}.bcfzip"'},
    )


@router.post("/projects/{project_id}/import")
async def import_project(project_id: str, file: UploadFile):
    file_bytes = await file.read()
    try:
        created = import_bcfzip(project_id, file_bytes)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Not a valid .bcfzip file")
    return {"imported_count": len(created), "topics": created}
