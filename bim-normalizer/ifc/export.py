"""
IFC4X3 export from normalised bim_* tables.

Geometry priority per element:
  1. IfcPolygonalFaceSet (Tessellation) from stored mesh — body representation
  2. IfcBoundingBox fallback when no mesh is available
Additionally, when available: an Axis representation (structural centerline,
from bim_geometry.axis) and a FootPrint representation (2D plan contour
loops, from bim_geometry.footprint) — both additive alongside the Body/Box
representation above, not a replacement for it.

Coordinate assumption: bim_geometry stores raw Speckle coordinates in
millimetres (Revit/Tekla/Speckle default). Pass coord_unit="m" for models
already in metres.
"""
import json
import logging
import os
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

_CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "config")

# canonical_key -> target IFC value type, for canonical concepts whose
# mapping_canonical.json 'psets' entries cleanly follow the
# Pset_<Class>Common convention across several element classes — the least
# ambiguous concepts to place correctly without a class-specific override
# table. grade/profile/assembly_mark could follow the same mechanism later,
# but their pset targets aren't as uniformly class-derivable (e.g. grade's
# real target, Pset_MaterialSteel.StructuralGrade, attaches to IfcMaterial
# rather than any one ifc_class).
_TYPED_PROPERTY_VALUE_TYPES = {
    "load_bearing":          "IfcBoolean",
    "fire_rating":           "IfcLabel",
    "thermal_transmittance": "IfcThermalTransmittanceMeasure",
}

# Boolean-valued Revit parameters (e.g. the "Structural"/Tragwerk checkbox
# behind load_bearing) render as whatever the source Revit installation's UI
# language spells "yes" — confirmed on a real ingested German-locale model
# (WALL_STRUCTURAL_SIGNIFICANT -> "Ja"), which the English-only check this
# used to have (("true","1","yes")) would silently coerce to IfcBoolean(False).
# Used by both _make_typed_value (canonical properties) and _make_ifc_value
# (generic properties) below, since the same source data feeds both paths.
_TRUTHY_VALUES = frozenset({
    "true", "1", "yes",       # English
    "ja", "wahr",             # German
    "oui", "vrai",            # French
    "sí", "si", "verdadero",  # Spanish
})


def _load_canonical_psets() -> dict[str, list[dict]]:
    """
    canonical_key -> its 'psets' entries from mapping_canonical.json,
    restricted to _TYPED_PROPERTY_VALUE_TYPES. Mirrors db/insert.py's
    _load_canonical_map(), reading the same config file for the opposite
    direction: placing an already-resolved canonical value correctly on
    export, instead of resolving a raw source key into one at ingest.
    """
    path = os.path.join(_CONFIG_DIR, "mapping_canonical.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        logger.warning("Could not load mapping_canonical.json for typed property export: %s", exc)
        return {}
    return {
        canonical: entry.get("psets", [])
        for canonical, entry in data.items()
        if canonical in _TYPED_PROPERTY_VALUE_TYPES
    }


_CANONICAL_PSETS = _load_canonical_psets()


def _pset_ifc_class(pset_name: str) -> str | None:
    """Derive the ifc_class a Pset_<Class>Common entry applies to, e.g.
    'Pset_WallCommon' -> 'IfcWall'. None for pset names that don't fit that
    convention (treated as applying regardless of class)."""
    if pset_name.startswith("Pset_") and pset_name.endswith("Common"):
        return "Ifc" + pset_name[len("Pset_"):-len("Common")]
    return None


def _resolve_typed_property(canonical_key: str, ifc_class: str) -> tuple[str, str] | None:
    """(pset_name, prop_key) for this canonical_key/ifc_class combo, or None
    if there's no applicable entry. Prefers an entry whose derived ifc_class
    matches exactly; falls back to a class-agnostic entry if present."""
    entries = _CANONICAL_PSETS.get(canonical_key, [])
    agnostic = None
    for entry in entries:
        pset_name = entry.get("pset", "")
        key = entry.get("key", "")
        if not pset_name or not key:
            continue
        target_class = _pset_ifc_class(pset_name)
        if target_class == ifc_class:
            return pset_name, key
        if target_class is None and agnostic is None:
            agnostic = (pset_name, key)
    return agnostic


def _make_typed_value(f, value_type: str, raw):
    """Construct an IFC value entity of a specific known type from a raw
    (string) parameter value — unlike _make_ifc_value() below, the target
    type is already known (from _TYPED_PROPERTY_VALUE_TYPES), not inferred
    from the source datatype."""
    if raw is None:
        return None
    try:
        if value_type == "IfcBoolean":
            return f.create_entity("IfcBoolean", str(raw).strip().lower() in _TRUTHY_VALUES)
        if value_type == "IfcThermalTransmittanceMeasure":
            return f.create_entity("IfcThermalTransmittanceMeasure", float(raw))
        return f.create_entity(value_type, str(raw)[:255])
    except Exception:
        return None

# Parameter keys (lower-cased) that carry element type / profile information
_OBJECT_TYPE_KEYS = frozenset({
    "type", "type name", "typename", "type_name",
    "family", "family and type", "family type",
    "profile", "profile name",
    "objecttype", "object type",
    "structural framing type",
    "revit family type",
})

# Same "material" key convention chat/agent.py's _query_materials and
# converge_mcp.py's speckle_get_materials already use (p.key ILIKE
# 'material%') — keeping this in sync means the exported IFC's material
# grouping matches whatever the rest of the app already considers "the
# material" for a given element.
_MATERIAL_KEY_PREFIX = "material"

# IFC GUIDs are exactly 22 chars from this base64-ish alphabet (see
# ifcopenshell.guid). Used only to distinguish "this application_id is
# already a real IFC GlobalId" (IFC-sourced models) from "this is a Revit
# ElementId or similar" (Revit-sourced models) — not a full validator.
_IFC_GUID_CHARS = frozenset(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
)


def _stable_global_id(elem: dict) -> str:
    """
    Deterministic GlobalId so re-exporting the same element always produces
    the same GUID. Previously every product entity got GlobalId=
    ifcopenshell.guid.new() — a fresh random GUID on *every* export, even for
    the exact same unchanged model — which silently broke anything tracking
    an element by its exported GlobalId across two exports (ifc_dependency_
    graph's by_guid() lookup, BCF viewpoints, any re-import round-trip).

    Prefers application_id when it's already IFC-GUID-shaped (22 chars, IFC's
    base64-ish alphabet) — true for IFC-sourced models — so the exported
    file's GlobalIds match the *original* source IFC's GlobalIds, not just
    each other. Falls back to deriving one from element_id (this DB row's
    stable primary key, never changes across re-exports) via the same
    compression scheme ifcopenshell.guid.new() itself uses internally, so
    even Revit-sourced elements (whose application_id is a Revit ElementId,
    not a GlobalId) get a GUID that's at least stable run to run.
    """
    app_id = (elem.get("application_id") or "").strip()
    if len(app_id) == 22 and all(c in _IFC_GUID_CHARS for c in app_id):
        return app_id
    hex_id = str(elem["element_id"]).replace("-", "")
    return ifcopenshell.guid.compress(hex_id)


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
    relationships: list[dict] | None = None,
) -> bytes:
    """
    Build an IFC4X3 file from normalised model data.

    model_row           – row from bim_models
    elements            – rows from bim_elements LEFT JOIN bim_geometry
                          columns: element_id, application_id, ifc_class, category,
                          name, storey, speckle_type, bbox_min, bbox_max, centroid,
                          mesh, volume_m3, area_m2, axis, footprint
    params_by_element   – {str(element_id): [{pset, key, value, datatype}]}
    coord_unit          – unit of coordinates stored in DB
    tasks, task_elements – optional 4D schedule (from db/schedule.py's
                          get_tasks_for_export); when given, an IfcWorkSchedule
                          is attached referencing the product entities created
                          below, so a valid IFC4D file. Not attempted standalone
                          — IfcRelAssignsToProcess must reference real entities
                          in the same file, so this only works alongside a full
                          geometry export, not as a schedule-only file.
    relationships        – optional [{element_id, related_id, relation_type}]
                          (from routers/ifc_export.py's
                          _load_relationships_for_export(), sourced from
                          bim_relationships — see db/insert.py's
                          build_relationships()). Emitted as
                          IfcRelConnectsElements once both sides' product
                          entities exist below — previously bim_relationships
                          was populated and queryable via the API/chat/MCP
                          tools but never reflected in the exported IFC file
                          itself. Uses one generic relationship entity rather
                          than trying to pick a different specific IFC
                          relationship type per relation_type (host/room/
                          space semantics vary too much to guess reliably) —
                          relation_type is preserved as the entity's Name so
                          the original meaning isn't lost.
    """
    scale = _UNIT_TO_M.get((coord_unit or "mm").lower(), 1e-3)
    f = ifcopenshell.file(schema=_IFC_SCHEMA)
    now_ts = int(datetime.now(timezone.utc).timestamp())

    owner_history, ctx, body_ctx, box_ctx, axis_ctx, footprint_ctx = _bootstrap(f, model_row, now_ts)

    # ── spatial hierarchy ──────────────────────────────────────────────────
    project  = _make_project(f, model_row, owner_history, ctx)
    site     = _make_spatial(f, "IfcSite",     "Site",     owner_history, project)
    building = _make_spatial(f, "IfcBuilding",
                             model_row.get("branch_name") or "Building",
                             owner_history, site)

    storey_elevations = _estimate_storey_elevations(elements, scale)
    unique_storeys = sorted({(e.get("storey") or "Level 0") for e in elements})

    # Every product entity below gets Tag=application_id (see tag= at the
    # _create_product call), letting a synthetic export's GlobalIds (always
    # freshly random — see _stable_global_id) be resolved back to the
    # originating bim_elements row. IfcBuildingStorey has no Tag attribute
    # at all in the IFC schema (Tag is IfcElement-only; storeys are
    # IfcSpatialStructureElement, a different branch — confirmed against the
    # IFC4X3 EXPRESS schema), so that trick doesn't apply here. If a Level
    # element matching this storey's name was itself ingested (category
    # "Levels", ifc_class "IfcBuildingStorey" — Levels are ingested as
    # ordinary elements alongside everything else), stash its application_id
    # in a small custom pset on the storey entity instead — the one thing
    # every IfcSpatialStructureElement can carry — so
    # ifc/relationship_types.py's resolve_relationship_element_ids can
    # resolve real IfcRelContainedInSpatialStructure/IfcRelAggregates
    # relationships back to a real element_id even for synthetic exports,
    # not just an original IFC's own GlobalIds.
    storey_app_ids: dict[str, str] = {
        e["name"]: e["application_id"]
        for e in elements
        if e.get("ifc_class") == "IfcBuildingStorey" and e.get("name") and e.get("application_id")
    }

    storey_map: dict[str, object] = {}
    for name in unique_storeys:
        elev = storey_elevations.get(name, 0.0)
        storey_entity = _make_storey(f, name, elev, owner_history)
        app_id = storey_app_ids.get(name)
        if app_id:
            _attach_psets(f, owner_history, storey_entity, [
                {"key": "application_id", "value": app_id, "pset": "Converge", "datatype": "string"},
            ])
        storey_map[name] = storey_entity

    f.create_entity(
        "IfcRelAggregates",
        GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
        RelatingObject=building, RelatedObjects=list(storey_map.values()),
    )

    # ── elements ──────────────────────────────────────────────────────────
    storey_contents: dict[str, list] = {s: [] for s in unique_storeys}
    element_id_map: dict[str, object] = {}
    material_groups: dict[str, list] = defaultdict(list)
    type_groups: dict[tuple[str, str], list] = defaultdict(list)

    for elem in elements:
        ifc_class  = elem.get("ifc_class") or "IfcBuildingElementProxy"
        storey_key = elem.get("storey") or "Level 0"
        centroid   = elem.get("centroid")

        elem_params = params_by_element.get(str(elem["element_id"]), [])
        object_type = _extract_object_type(elem_params)
        tag = (elem.get("application_id") or "").strip() or None

        # Body: tessellation mesh first, bounding box fallback. Axis/FootPrint
        # are additive on top of whichever Body representation (or lack of
        # one) resulted — every case that previously got a Body/Box
        # representation still gets exactly that, unchanged.
        mesh_data = elem.get("mesh")
        body_rep = None
        if mesh_data and mesh_data.get("vertices") and mesh_data.get("faces"):
            body_rep = _mesh_shape(f, body_ctx, mesh_data, scale, centroid)
        if body_rep is None:
            body_rep = _bbox_shape(f, box_ctx, elem, scale)

        axis_rep = _axis_shape(f, axis_ctx, elem.get("axis"), scale, centroid)
        footprint_rep = _footprint_shape(f, footprint_ctx, elem.get("footprint"), scale, centroid)

        reps = [r for r in (body_rep, axis_rep, footprint_rep) if r is not None]
        shape = f.create_entity("IfcProductDefinitionShape", Representations=reps) if reps else None

        placement = _make_placement(f, centroid, scale)

        ifc_elem = _create_product(
            f, ifc_class, owner_history, placement, shape,
            name=elem.get("name") or "",
            description=elem.get("speckle_type") or "",
            global_id=_stable_global_id(elem),
            object_type=object_type,
            tag=tag,
        )

        if elem_params:
            elem_params = _attach_typed_properties(f, owner_history, ifc_elem, ifc_class, elem_params)
            if elem_params:
                _attach_psets(f, owner_history, ifc_elem, elem_params)

        vol  = elem.get("volume_m3")
        area = elem.get("area_m2")
        if vol is not None or area is not None:
            _attach_quantities(f, owner_history, ifc_elem, vol, area)

        material_name = _extract_material_name(elem_params)
        if material_name:
            material_groups[material_name].append(ifc_elem)

        if object_type:
            type_groups[(ifc_class, object_type)].append(ifc_elem)

        storey_contents[storey_key].append(ifc_elem)
        element_id_map[str(elem["element_id"])] = ifc_elem

    for sname, contained in storey_contents.items():
        if contained:
            f.create_entity(
                "IfcRelContainedInSpatialStructure",
                GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                RelatingStructure=storey_map[sname], RelatedElements=contained,
            )

    # One IfcMaterial per distinct material name, one IfcRelAssociatesMaterial
    # per material batching all elements that share it — not one relationship
    # per element, which would work but bloat the file and isn't how IFC
    # normally represents "N elements share this material".
    for material_name, ifc_elems in material_groups.items():
        material_entity = f.create_entity("IfcMaterial", Name=material_name[:255])
        f.create_entity(
            "IfcRelAssociatesMaterial",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            RelatedObjects=ifc_elems, RelatingMaterial=material_entity,
        )

    # One shared type object per distinct (ifc_class, object_type) — e.g. one
    # IfcBeamType named "HEA300" linked to every HEA300 beam instance via
    # IfcRelDefinesByType, instead of every instance being a standalone
    # entity with no shared type the way this export used to work. Not every
    # IFC class has a "...Type" companion entity; ifcopenshell rejects the
    # ones that don't, so this degrades gracefully (no type object for that
    # group) rather than fail the whole export, mirroring _create_product's
    # own unknown-class handling above.
    type_object_count = 0
    for (ifc_class, object_type), ifc_elems in type_groups.items():
        if not ifc_class.startswith("Ifc"):
            continue
        try:
            type_entity = f.create_entity(
                f"Ifc{ifc_class[3:]}Type",
                GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
                Name=object_type,
            )
        except Exception:
            continue
        f.create_entity(
            "IfcRelDefinesByType",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            RelatingType=type_entity, RelatedObjects=ifc_elems,
        )
        type_object_count += 1

    # Element-to-element relationships (parent/room/space — see
    # build_relationships() in db/insert.py). Both sides must have a product
    # entity in *this* export to link them; skip silently otherwise (e.g. the
    # related element was filtered/failed during this particular export, or
    # — for room/space — wasn't ingested as an element at all).
    relationship_count = 0
    for rel in (relationships or []):
        a = element_id_map.get(rel.get("element_id"))
        b = element_id_map.get(rel.get("related_id"))
        if a is None or b is None:
            continue
        f.create_entity(
            "IfcRelConnectsElements",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            Name=rel.get("relation_type") or "",
            RelatingElement=a, RelatedElement=b,
        )
        relationship_count += 1

    if tasks:
        _build_schedule(f, model_row, tasks, task_elements or {}, element_id_map)

    logger.info(
        "IFC4X3 export: %d elements, %d storeys, %d relationships, %d type objects — model %s",
        len(elements), len(storey_map), relationship_count, type_object_count, model_row.get("model_id"),
    )
    return f.to_string().encode("utf-8")


# ---------------------------------------------------------------------------
# 4D schedule (IfcWorkSchedule / IfcTask / IfcRelAssignsToProcess)
# ---------------------------------------------------------------------------

def export_schedule_only(model_row: dict, tasks: list[dict]) -> bytes:
    """
    Minimal IFC4X3 file containing just IfcProject + IfcWorkSchedule/IfcTask
    (no building elements) — for round-tripping the current schedule to
    other tools without the cost of a full geometry export. Deliberately
    skips assign_process() — see export_model()'s docstring on why that
    needs real product entities in the same file; schedule-only files have
    none, so task_elements/element_id_map are passed empty here.
    """
    f = ifcopenshell.file(schema=_IFC_SCHEMA)
    now_ts = int(datetime.now(timezone.utc).timestamp())
    owner_history, ctx, _body_ctx, _box_ctx, _axis_ctx, _footprint_ctx = _bootstrap(f, model_row, now_ts)
    _make_project(f, model_row, owner_history, ctx)
    _build_schedule(f, model_row, tasks, {}, {})
    return f.to_string().encode("utf-8")


def _ifc_duration_days(days: float) -> str:
    """Format a day count as an ISO-8601 IfcDuration string, matching the
    fractional-day format db/schedule.py's _parse_ifc_duration already
    accepts when reading it back (\\d+(?:\\.\\d+)?D)."""
    return f"P{days:g}D"


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
        if task.get("status"):
            ifc_task.Status = task["status"]

        date_fields = ("planned_start", "planned_finish", "actual_start", "actual_finish")
        # IsCritical/TotalFloat round-trip: is_critical/float_days are computed
        # in-app by db/cpm.py's CPM engine on every task/dependency mutation,
        # so this always reflects our own critical-path calculation, not
        # whatever (if anything) the original imported file claimed.
        if any(task.get(k) for k in date_fields) or task.get("is_critical") or task.get("float_days") is not None:
            task_time = add_task_time(f, task=ifc_task)
            if task.get("planned_start"):  task_time.ScheduleStart  = task["planned_start"]
            if task.get("planned_finish"): task_time.ScheduleFinish = task["planned_finish"]
            if task.get("actual_start"):   task_time.ActualStart    = task["actual_start"]
            if task.get("actual_finish"):  task_time.ActualFinish   = task["actual_finish"]
            task_time.IsCritical = bool(task.get("is_critical"))
            if task.get("float_days") is not None:
                task_time.TotalFloat = _ifc_duration_days(task["float_days"])

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
    # Sub-contexts for the structural-centerline (Axis) and plan-contour
    # (FootPrint) representations — TargetView follows the IFC convention
    # for each (GRAPH_VIEW for axis/wireframe curves, PLAN_VIEW for 2D plan
    # contours), matching how MODEL_VIEW is used for Body/Box above.
    axis_ctx = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Axis", ContextType="Model",
        ParentContext=ctx, TargetView="GRAPH_VIEW",
    )
    footprint_ctx = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="FootPrint", ContextType="Model",
        ParentContext=ctx, TargetView="PLAN_VIEW",
    )
    return owner_history, ctx, body_ctx, box_ctx, axis_ctx, footprint_ctx


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
    IfcPolygonalFaceSet body IfcShapeRepresentation from stored mesh data.
    Vertices are translated to centroid-local space so they align with the
    element's IfcLocalPlacement.

    Vertices are stored as [[x,y,z], [x,y,z], ...] triplets (geometry.py
    converts Speckle's flat array before storing in JSONB).

    Returns a bare IfcShapeRepresentation (not wrapped in an
    IfcProductDefinitionShape) — the caller combines this with Axis/FootPrint
    representations into one shared IfcProductDefinitionShape per element.
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
    return f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=body_ctx,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation",
        Items=[face_set],
    )


def _bbox_shape(f, box_ctx, elem: dict, scale: float):
    """
    IfcBoundingBox fallback IfcShapeRepresentation.
    Corner is expressed in local space relative to the centroid placement.
    Returns a bare IfcShapeRepresentation — see _mesh_shape's docstring.
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
        return f.create_entity(
            "IfcShapeRepresentation",
            ContextOfItems=box_ctx,
            RepresentationIdentifier="Box",
            RepresentationType="BoundingBox",
            Items=[bbox],
        )
    except Exception as exc:
        logger.debug("BBox shape failed: %s", exc)
        return None


def _local_points(f, points: list, scale: float, centroid=None):
    """Shared centroid-relative/scale point transform for _axis_shape/
    _footprint_shape, matching _mesh_shape/_bbox_shape's convention exactly
    so Axis/FootPrint line up with the element's IfcLocalPlacement."""
    cx = float(centroid[0]) if centroid and len(centroid) > 0 else 0.0
    cy = float(centroid[1]) if centroid and len(centroid) > 1 else 0.0
    cz = float(centroid[2]) if centroid and len(centroid) > 2 else 0.0
    return [
        f.create_entity("IfcCartesianPoint", Coordinates=(
            (float(p[0]) - cx) * scale,
            (float(p[1]) - cy) * scale,
            (float(p[2]) - cz) * scale,
        ))
        for p in points
    ]


def _axis_shape(f, axis_ctx, axis_data: dict | None, scale: float, centroid=None):
    """
    IfcPolyline Axis IfcShapeRepresentation (RepresentationIdentifier="Axis",
    RepresentationType="Curve3D") from stored axis points — the structural
    centerline. axis_data is bim_geometry.axis, shaped
    {"points": [[x,y,z],[x,y,z],...]} (see ifc/geometry.py::extract_axis_footprint).
    """
    if not axis_data or not axis_data.get("points"):
        return None
    pts = axis_data["points"]
    if len(pts) < 2:
        return None
    try:
        cart_pts = _local_points(f, pts, scale, centroid)
    except (IndexError, ValueError, TypeError) as exc:
        logger.debug("Axis shape point parse error: %s", exc)
        return None
    polyline = f.create_entity("IfcPolyline", Points=cart_pts)
    return f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=axis_ctx,
        RepresentationIdentifier="Axis",
        RepresentationType="Curve3D",
        Items=[polyline],
    )


def _footprint_shape(f, footprint_ctx, footprint_data: dict | None, scale: float, centroid=None):
    """
    FootPrint IfcShapeRepresentation (RepresentationIdentifier="FootPrint")
    — the 2D plan contour, as one closed IfcPolyline per loop (outer
    boundary + inner holes). footprint_data is bim_geometry.footprint,
    shaped {"loops": [[[x,y,z],...], ...]} (see
    ifc/geometry.py::extract_axis_footprint) — each loop is stored open
    (without a duplicated closing point); closed here by re-appending each
    loop's first point. RepresentationType="Curve3D" permits Items to be a
    set of curves, so multiple loops (holes included) attach directly
    without needing an IfcArbitraryProfileDefWithVoids/IfcCompositeCurve
    wrapper.
    """
    if not footprint_data or not footprint_data.get("loops"):
        return None
    items = []
    try:
        for loop in footprint_data["loops"]:
            if len(loop) < 3:
                continue
            cart_pts = _local_points(f, loop, scale, centroid)
            cart_pts.append(cart_pts[0])  # close the loop
            items.append(f.create_entity("IfcPolyline", Points=cart_pts))
    except (IndexError, ValueError, TypeError) as exc:
        logger.debug("FootPrint shape point parse error: %s", exc)
        return None
    if not items:
        return None
    return f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=footprint_ctx,
        RepresentationIdentifier="FootPrint",
        RepresentationType="Curve3D",
        Items=items,
    )


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


def _extract_material_name(params: list[dict]) -> str | None:
    """
    The element's material, preferring canonical_key='material' — the
    IFC-standard, source-agnostic name db/query.py's own material/grade/
    profile queries already treat as the primary signal (populated at ingest
    from mapping_canonical.json, ahead of any raw key heuristic). Falls back
    to a raw 'material%'-prefixed key only for parameters ingested before
    canonical_key existed, matching the same primary/fallback pattern
    db/query.py's _param_distribution() already establishes elsewhere.
    """
    for p in params:
        if p.get("canonical_key") == "material":
            val = p.get("value")
            if val and str(val).strip():
                return str(val).strip()
    for p in params:
        key = (p.get("key") or "")
        if key.lower().startswith(_MATERIAL_KEY_PREFIX):
            val = p.get("value")
            if val and str(val).strip():
                return str(val).strip()
    return None


def _create_product(
    f, ifc_class: str, owner_history, placement, shape,
    name: str, description: str,
    global_id: str,
    object_type: str | None = None,
    tag: str | None = None,
):
    kwargs = dict(
        GlobalId=global_id, OwnerHistory=owner_history,
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
        logger.warning(
            "Unknown/unsupported IFC class %r for %s — falling back to "
            "IfcBuildingElementProxy. Original class preserved in Description "
            "and as an explicit ConvergeExport.OriginalIfcClass property, not "
            "just silently discarded.", ifc_class, _IFC_SCHEMA,
        )
        kwargs["Description"] = f"{ifc_class} | {description}" if description else ifc_class
        kwargs.pop("Tag", None)
        entity = f.create_entity("IfcBuildingElementProxy", **kwargs)
        if tag:
            try:
                entity.Tag = tag
            except Exception:
                pass
        pset = f.create_entity(
            "IfcPropertySet",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            Name="ConvergeExport",
            HasProperties=[f.create_entity(
                "IfcPropertySingleValue", Name="OriginalIfcClass",
                NominalValue=f.create_entity("IfcLabel", ifc_class),
            )],
        )
        f.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner_history,
            RelatedObjects=[entity], RelatingPropertyDefinition=pset,
        )
        return entity


# ---------------------------------------------------------------------------
# Property sets and quantities
# ---------------------------------------------------------------------------

def _attach_typed_properties(f, owner_history, element, ifc_class: str, params: list[dict]) -> list[dict]:
    """
    For any parameter whose canonical_key is in _TYPED_PROPERTY_VALUE_TYPES
    and resolves to a Pset placement for this element's ifc_class, emit it
    as a properly-typed IfcPropertySet/IfcRelDefinesByProperties under the
    IFC-standard Pset name (e.g. Pset_WallCommon.LoadBearing as a real
    IfcBoolean) instead of generic free text under whatever raw pset name
    was captured at ingest.

    Returns the remaining (unmatched) params for the caller to pass to
    _attach_psets() as before — a parameter is never emitted both ways.
    """
    remainder = []
    by_pset: dict[str, list] = {}
    for p in params:
        value_type = _TYPED_PROPERTY_VALUE_TYPES.get(p.get("canonical_key"))
        resolved = _resolve_typed_property(p.get("canonical_key"), ifc_class) if value_type else None
        if not resolved:
            remainder.append(p)
            continue
        nominal = _make_typed_value(f, value_type, p.get("value"))
        if nominal is None:
            remainder.append(p)
            continue
        pset_name, prop_key = resolved
        by_pset.setdefault(pset_name, []).append((prop_key, nominal))

    for pset_name, props in by_pset.items():
        prop_entities = [
            f.create_entity("IfcPropertySingleValue", Name=key, NominalValue=nominal)
            for key, nominal in props
        ]
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
    return remainder


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
            return f.create_entity("IfcBoolean", str(raw).lower() in _TRUTHY_VALUES)
        if dt == "measure":
            return f.create_entity("IfcLengthMeasure", float(raw))
        return f.create_entity("IfcLabel", str(raw)[:255])
    except Exception:
        try:
            return f.create_entity("IfcLabel", str(raw)[:255])
        except Exception:
            return None
