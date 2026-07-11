"""
IFC4X3 export from normalised bim_* tables.

Geometry priority per element:
  1. IfcPolygonalFaceSet (Tessellation) from stored mesh — body representation
  2. IfcBoundingBox fallback when no mesh is available

Coordinate assumption: bim_geometry stores raw Speckle coordinates in
millimetres (Revit/Tekla/Speckle default). Pass coord_unit="m" for models
already in metres.
"""
import logging
from collections import defaultdict
from datetime import datetime, timezone

import ifcopenshell
import ifcopenshell.guid
from ifcopenshell.api.sequence.add_work_schedule import add_work_schedule
from ifcopenshell.api.sequence.add_task import add_task
from ifcopenshell.api.sequence.add_task_time import add_task_time
from ifcopenshell.api.sequence.assign_process import assign_process

logger = logging.getLogger(__name__)

_IFC_SCHEMA = "IFC4X3"
_UNIT_TO_M = {"mm": 1e-3, "cm": 1e-2, "m": 1.0, "in": 0.0254, "ft": 0.3048}

# Parameter keys (lower-cased) that carry element type / profile information
_OBJECT_TYPE_KEYS = frozenset({
    "type", "type name", "typename", "type_name",
    "family", "family and type", "family type",
    "profile", "profile name",
    "objecttype", "object type",
    "structural framing type",
    "revit family type",
})


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def export_model(
    model_row: dict,
    elements: list[dict],
    params_by_element: dict[str, list],
    coord_unit: str = "mm",
    tasks: list[dict] | None = None,
    task_elements: dict[str, list[str]] | None = None,
) -> bytes:
    """
    Build an IFC4X3 file from normalised model data.

    model_row           – row from bim_models
    elements            – rows from bim_elements LEFT JOIN bim_geometry
                          columns: element_id, application_id, ifc_class, category,
                          name, storey, speckle_type, bbox_min, bbox_max, centroid,
                          mesh, volume_m3, area_m2
    params_by_element   – {str(element_id): [{pset, key, value, datatype}]}
    coord_unit          – unit of coordinates stored in DB
    tasks, task_elements – optional 4D schedule (from db/schedule.py's
                          get_tasks_for_export); when given, an IfcWorkSchedule
                          is attached referencing the product entities created
                          below, so a valid IFC4D file. Not attempted standalone
                          — IfcRelAssignsToProcess must reference real entities
                          in the same file, so this only works alongside a full
                          geometry export, not as a schedule-only file.
    """
    scale = _UNIT_TO_M.get((coord_unit or "mm").lower(), 1e-3)
    f = ifcopenshell.file(schema=_IFC_SCHEMA)
    now_ts = int(datetime.now(timezone.utc).timestamp())

    owner_history, ctx, body_ctx, box_ctx = _bootstrap(f, model_row, now_ts)

    # ── spatial hierarchy ──────────────────────────────────────────────────
    project  = _make_project(f, model_row, owner_history, ctx)
    site     = _make_spatial(f, "IfcSite",     "Site",     owner_history, project)
    building = _make_spatial(f, "IfcBuilding",
                             model_row.get("branch_name") or "Building",
                             owner_history, site)

    storey_elevations = _estimate_storey_elevations(elements, scale)
    unique_storeys = sorted({(e.get("storey") or "Level 0") for e in elements})

    storey_map: dict[str, object] = {}
    for name in unique_storeys:
        elev = storey_elevations.get(name, 0.0)
        storey_map[name] = _make_storey(f, name, elev, owner_history)

    f.create_entity(
        "IfcRelAggregates",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        RelatingObject=building, RelatedObjects=list(storey_map.values()),
    )

    # ── elements ──────────────────────────────────────────────────────────
    storey_contents: dict[str, list] = {s: [] for s in unique_storeys}
    element_id_map: dict[str, object] = {}

    for elem in elements:
        ifc_class  = elem.get("ifc_class") or "IfcBuildingElementProxy"
        storey_key = elem.get("storey") or "Level 0"
        centroid   = elem.get("centroid")

        elem_params = params_by_element.get(str(elem["element_id"]), [])
        object_type = _extract_object_type(elem_params)
        tag = (elem.get("application_id") or "").strip() or None

        # Geometry: tessellation mesh first, bounding box fallback
        mesh_data = elem.get("mesh")
        shape = None
        if mesh_data and mesh_data.get("vertices") and mesh_data.get("faces"):
            shape = _mesh_shape(f, body_ctx, mesh_data, scale, centroid)
        if shape is None:
            shape = _bbox_shape(f, box_ctx, elem, scale)

        placement = _make_placement(f, centroid, scale)

        ifc_elem = _create_product(
            f, ifc_class, owner_history, placement, shape,
            name=elem.get("name") or "",
            description=elem.get("speckle_type") or "",
            object_type=object_type,
            tag=tag,
        )

        if elem_params:
            _attach_psets(f, owner_history, ifc_elem, elem_params)

        vol  = elem.get("volume_m3")
        area = elem.get("area_m2")
        if vol is not None or area is not None:
            _attach_quantities(f, owner_history, ifc_elem, vol, area)

        storey_contents[storey_key].append(ifc_elem)
        element_id_map[str(elem["element_id"])] = ifc_elem

    for sname, contained in storey_contents.items():
        if contained:
            f.create_entity(
                "IfcRelContainedInSpatialStructure",
                GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                RelatingStructure=storey_map[sname], RelatedElements=contained,
            )

    if tasks:
        _build_schedule(f, model_row, tasks, task_elements or {}, element_id_map)

    logger.info(
        "IFC4X3 export: %d elements, %d storeys — model %s",
        len(elements), len(storey_map), model_row.get("model_id"),
    )
    return f.to_string().encode("utf-8")


# ---------------------------------------------------------------------------
# 4D schedule (IfcWorkSchedule / IfcTask / IfcRelAssignsToProcess)
# ---------------------------------------------------------------------------

def _build_schedule(
    f, model_row: dict, tasks: list[dict],
    task_elements: dict[str, list[str]], element_id_map: dict[str, object],
) -> None:
    """
    Build IfcWorkSchedule/IfcTask/IfcTaskTime/IfcRelAssignsToProcess from
    db/schedule.py's get_tasks_for_export() shape, using ifcopenshell's
    sequence API (add_work_schedule/add_task/add_task_time/assign_process)
    rather than this file's usual raw create_entity style — that API
    correctly handles the several required nested relationship types
    (IfcRelNests, IfcRelAssignsToControl) that are easy to get subtly wrong
    by hand, and it auto-links the schedule to the sole IfcProject in the
    file via IfcRelDeclares.
    """
    work_schedule = add_work_schedule(f, name=model_row.get("branch_name") or "Construction Schedule")

    by_parent: dict[str | None, list[dict]] = defaultdict(list)
    for t in tasks:
        by_parent[t.get("parent_task_id")].append(t)
    for children in by_parent.values():
        children.sort(key=lambda t: t.get("sort_order") or 0)

    def _create(task: dict, parent_ifc_task) -> None:
        ifc_task = add_task(
            f,
            work_schedule=work_schedule if parent_ifc_task is None else None,
            parent_task=parent_ifc_task,
            name=task.get("name") or "Unnamed Task",
            identification=task.get("wbs_code"),
        )
        ifc_task.IsMilestone = bool(task.get("is_milestone"))

        date_fields = ("planned_start", "planned_finish", "actual_start", "actual_finish")
        if any(task.get(k) for k in date_fields):
            task_time = add_task_time(f, task=ifc_task)
            if task.get("planned_start"):  task_time.ScheduleStart  = task["planned_start"]
            if task.get("planned_finish"): task_time.ScheduleFinish = task["planned_finish"]
            if task.get("actual_start"):   task_time.ActualStart    = task["actual_start"]
            if task.get("actual_finish"):  task_time.ActualFinish   = task["actual_finish"]

        for element_id in task_elements.get(task["task_id"], []):
            product = element_id_map.get(element_id)
            if product is not None:
                assign_process(f, relating_process=ifc_task, related_object=product)

        for child in by_parent.get(task["task_id"], []):
            _create(child, ifc_task)

    for root in by_parent.get(None, []):
        _create(root, None)


# ---------------------------------------------------------------------------
# Bootstrap (owner history + geometric contexts)
# ---------------------------------------------------------------------------

def _bootstrap(f, model_row: dict, now_ts: int):
    person    = f.create_entity("IfcPerson",       FamilyName="bim-normalizer")
    org       = f.create_entity("IfcOrganization",  Name=model_row.get("source") or "Unknown")
    p_and_o   = f.create_entity("IfcPersonAndOrganization", ThePerson=person, TheOrganization=org)
    app       = f.create_entity(
        "IfcApplication",
        ApplicationDeveloper=org, Version="1.0",
        ApplicationFullName="bim-normalizer", ApplicationIdentifier="bim-normalizer",
    )
    owner_history = f.create_entity(
        "IfcOwnerHistory",
        OwningUser=p_and_o, OwningApplication=app,
        ChangeAction="ADDED", CreationDate=now_ts,
    )

    origin   = f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    z_axis   = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    x_axis   = f.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    world_cs = f.create_entity("IfcAxis2Placement3D", Location=origin, Axis=z_axis, RefDirection=x_axis)
    ctx      = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model", CoordinateSpaceDimension=3,
        Precision=1.0e-5, WorldCoordinateSystem=world_cs,
    )
    # Sub-contexts for body (tessellation) and bounding box
    body_ctx = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body", ContextType="Model",
        ParentContext=ctx, TargetView="MODEL_VIEW",
    )
    box_ctx = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Box", ContextType="Model",
        ParentContext=ctx, TargetView="MODEL_VIEW",
    )
    return owner_history, ctx, body_ctx, box_ctx


def _make_project(f, model_row: dict, owner_history, ctx):
    length_unit = f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    area_unit   = f.create_entity("IfcSIUnit", UnitType="AREAUNIT",   Name="SQUARE_METRE")
    vol_unit    = f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    units       = f.create_entity("IfcUnitAssignment", Units=[length_unit, area_unit, vol_unit])
    return f.create_entity(
        "IfcProject",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name=model_row.get("stream_id") or "Project",
        Description=model_row.get("message") or "",
        RepresentationContexts=[ctx], UnitsInContext=units,
    )


def _make_spatial(f, ifc_type: str, name: str, owner_history, parent):
    entity = f.create_entity(
        ifc_type,
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name=name, ObjectPlacement=_make_placement(f),
        CompositionType="ELEMENT",
    )
    if parent is not None:
        f.create_entity(
            "IfcRelAggregates",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            RelatingObject=parent, RelatedObjects=[entity],
        )
    return entity


def _make_storey(f, name: str, elevation: float, owner_history):
    """IfcBuildingStorey with estimated Z elevation."""
    pt = f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, elevation))
    ap = f.create_entity("IfcAxis2Placement3D", Location=pt)
    placement = f.create_entity("IfcLocalPlacement", RelativePlacement=ap)
    return f.create_entity(
        "IfcBuildingStorey",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name=name, ObjectPlacement=placement,
        CompositionType="ELEMENT", Elevation=elevation,
    )


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _estimate_storey_elevations(elements: list[dict], scale: float) -> dict[str, float]:
    """Return min centroid-Z per storey as floor elevation estimate (in metres)."""
    z_values: dict[str, list] = defaultdict(list)
    for e in elements:
        centroid = e.get("centroid")
        if centroid and len(centroid) >= 3:
            storey = e.get("storey") or "Level 0"
            try:
                z_values[storey].append(float(centroid[2]) * scale)
            except (ValueError, TypeError):
                pass
    return {s: min(zs) for s, zs in z_values.items() if zs}


def _make_placement(f, coords=None, scale: float = 1e-3):
    xyz = tuple(float(c) * scale for c in (coords or [0.0, 0.0, 0.0]))
    pt  = f.create_entity("IfcCartesianPoint", Coordinates=xyz)
    ap  = f.create_entity("IfcAxis2Placement3D", Location=pt)
    return f.create_entity("IfcLocalPlacement", RelativePlacement=ap)


def _mesh_shape(f, body_ctx, mesh_data: dict, scale: float, centroid=None):
    """
    IfcPolygonalFaceSet body representation from stored mesh data.
    Vertices are translated to centroid-local space so they align with the
    element's IfcLocalPlacement.

    Vertices are stored as [[x,y,z], [x,y,z], ...] triplets (geometry.py
    converts Speckle's flat array before storing in JSONB).
    """
    raw_verts = mesh_data.get("vertices") or []
    raw_faces = mesh_data.get("faces") or []
    if not raw_verts or not raw_faces:
        return None

    # Detect storage format: triplets [[x,y,z],...] vs flat [x,y,z,x,y,z,...]
    if isinstance(raw_verts[0], (list, tuple)):
        triplets = raw_verts            # already [[x,y,z], ...]
    else:
        # flat array — group into triplets
        triplets = [
            [raw_verts[i], raw_verts[i + 1], raw_verts[i + 2]]
            for i in range(0, len(raw_verts) - 2, 3)
        ]

    n_verts = len(triplets)
    if n_verts < 3:
        return None

    # Centroid offset — vertices are in absolute world coords, make them local
    cx = float(centroid[0]) if centroid and len(centroid) > 0 else 0.0
    cy = float(centroid[1]) if centroid and len(centroid) > 1 else 0.0
    cz = float(centroid[2]) if centroid and len(centroid) > 2 else 0.0

    try:
        point_list = [
            (
                (float(v[0]) - cx) * scale,
                (float(v[1]) - cy) * scale,
                (float(v[2]) - cz) * scale,
            )
            for v in triplets
        ]
    except (IndexError, ValueError, TypeError) as exc:
        logger.debug("Mesh vertex parse error: %s", exc)
        return None

    coord_list = f.create_entity("IfcCartesianPointList3D", CoordList=point_list)

    # Parse run-length encoded face list: [n, i0, i1, ..., n, i0, i1, ...]
    # Handles legacy format (0=tri, 1=quad) as well as current format.
    # IFC CoordIndex is 1-based.
    ifc_faces = []
    i = 0
    while i < len(raw_faces):
        try:
            raw_n = int(raw_faces[i])
        except (ValueError, TypeError):
            break
        # Normalise legacy Speckle encoding: 0 = triangle, 1 = quad
        n = raw_n if raw_n >= 3 else (3 if raw_n == 0 else 4)
        end = i + n + 1
        if n < 3 or end > len(raw_faces):
            i = end
            continue
        try:
            indices = [int(raw_faces[i + 1 + k]) + 1 for k in range(n)]  # 0-based → 1-based
        except (ValueError, TypeError):
            i = end
            continue
        if all(1 <= idx <= n_verts for idx in indices):
            ifc_faces.append(f.create_entity("IfcIndexedPolygonalFace", CoordIndex=indices))
        i = end

    if not ifc_faces:
        return None

    face_set = f.create_entity(
        "IfcPolygonalFaceSet",
        Coordinates=coord_list,
        Closed=False,
        Faces=ifc_faces,
    )
    shape_rep = f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=body_ctx,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation",
        Items=[face_set],
    )
    return f.create_entity("IfcProductDefinitionShape", Representations=[shape_rep])


def _bbox_shape(f, box_ctx, elem: dict, scale: float):
    """
    IfcBoundingBox fallback representation.
    Corner is expressed in local space relative to the centroid placement.
    """
    bbox_min = elem.get("bbox_min")
    bbox_max = elem.get("bbox_max")
    if not bbox_min or not bbox_max:
        return None
    centroid = elem.get("centroid") or [0.0, 0.0, 0.0]
    try:
        cx = float(centroid[0]) if len(centroid) > 0 else 0.0
        cy = float(centroid[1]) if len(centroid) > 1 else 0.0
        cz = float(centroid[2]) if len(centroid) > 2 else 0.0
        corner = f.create_entity("IfcCartesianPoint", Coordinates=(
            (float(bbox_min[0]) - cx) * scale,
            (float(bbox_min[1]) - cy) * scale,
            (float(bbox_min[2]) - cz) * scale,
        ))
        dx = abs(float(bbox_max[0]) - float(bbox_min[0])) * scale
        dy = abs(float(bbox_max[1]) - float(bbox_min[1])) * scale
        dz = abs(float(bbox_max[2]) - float(bbox_min[2])) * scale
        if dx == 0.0 and dy == 0.0 and dz == 0.0:
            return None
        bbox = f.create_entity("IfcBoundingBox", Corner=corner, XDim=dx, YDim=dy, ZDim=dz)
        shape_rep = f.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=box_ctx,
            RepresentationIdentifier="Box",
            RepresentationType="BoundingBox",
            Items=[bbox],
        )
        return f.create_entity("IfcProductDefinitionShape", Representations=[shape_rep])
    except Exception as exc:
        logger.debug("BBox shape failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Element creation
# ---------------------------------------------------------------------------

def _extract_object_type(params: list[dict]) -> str | None:
    """Look for a type/profile/family parameter to populate ObjectType."""
    for p in params:
        if (p.get("key") or "").lower().strip() in _OBJECT_TYPE_KEYS:
            val = p.get("value")
            if val and str(val).strip():
                return str(val).strip()[:255]
    return None


def _create_product(
    f, ifc_class: str, owner_history, placement, shape,
    name: str, description: str,
    object_type: str | None = None,
    tag: str | None = None,
):
    kwargs = dict(
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name=name, Description=description,
        ObjectPlacement=placement, Representation=shape,
    )
    if object_type:
        kwargs["ObjectType"] = object_type
    if tag:
        kwargs["Tag"] = tag
    try:
        return f.create_entity(ifc_class, **kwargs)
    except Exception:
        logger.debug("Unknown IFC class %r — falling back to IfcBuildingElementProxy", ifc_class)
        kwargs["Description"] = f"{ifc_class} | {description}"
        kwargs.pop("Tag", None)
        entity = f.create_entity("IfcBuildingElementProxy", **kwargs)
        if tag:
            try:
                entity.Tag = tag
            except Exception:
                pass
        return entity


# ---------------------------------------------------------------------------
# Property sets and quantities
# ---------------------------------------------------------------------------

def _attach_psets(f, owner_history, element, params: list[dict]) -> None:
    pset_groups: dict[str, list] = {}
    for p in params:
        key = p.get("key") or ""
        if not key:
            continue
        pset_groups.setdefault(p.get("pset") or "General", []).append(p)

    for pset_name, props in pset_groups.items():
        prop_entities = []
        for p in props:
            nominal = _make_ifc_value(f, p.get("value"), p.get("datatype") or "string")
            if nominal is None:
                continue
            prop_entities.append(
                f.create_entity("IfcPropertySingleValue", Name=p["key"], NominalValue=nominal)
            )
        if not prop_entities:
            continue
        pset = f.create_entity(
            "IfcPropertySet",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            Name=pset_name, HasProperties=prop_entities,
        )
        f.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            RelatedObjects=[element], RelatingPropertyDefinition=pset,
        )


def _attach_quantities(f, owner_history, element, volume_m3, area_m2) -> None:
    """Attach IfcElementQuantity with area and/or volume."""
    quantities = []
    if area_m2 is not None:
        try:
            quantities.append(
                f.create_entity("IfcQuantityArea", Name="NetSideArea", AreaValue=float(area_m2))
            )
        except Exception as exc:
            logger.debug("IfcQuantityArea failed: %s", exc)
    if volume_m3 is not None:
        try:
            quantities.append(
                f.create_entity("IfcQuantityVolume", Name="NetVolume", VolumeValue=float(volume_m3))
            )
        except Exception as exc:
            logger.debug("IfcQuantityVolume failed: %s", exc)
    if not quantities:
        return
    qset = f.create_entity(
        "IfcElementQuantity",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        Name="BaseQuantities", Quantities=quantities,
    )
    f.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        RelatedObjects=[element], RelatingPropertyDefinition=qset,
    )


def _make_ifc_value(f, raw, datatype: str):
    """Map a stored parameter value to the appropriate IfcSimpleValue subtype."""
    if raw is None:
        return None
    dt = (datatype or "string").lower()
    try:
        if dt in ("int", "integer"):
            return f.create_entity("IfcInteger", int(raw))
        if dt in ("float", "real", "double", "number"):
            return f.create_entity("IfcReal", float(raw))
        if dt == "bool":
            return f.create_entity("IfcBoolean", str(raw).lower() in ("true", "1", "yes"))
        if dt == "measure":
            return f.create_entity("IfcLengthMeasure", float(raw))
        return f.create_entity("IfcLabel", str(raw)[:255])
    except Exception:
        try:
            return f.create_entity("IfcLabel", str(raw)[:255])
        except Exception:
            return None
