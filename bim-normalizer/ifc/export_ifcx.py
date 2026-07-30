"""
EXPERIMENTAL IFC5 (.ifcx) export from normalised bim_* tables.

IFC5 is buildingSMART's next-generation, still-unratified alpha spec —
`.ifcx` is a flat JSON changeset format, not STEP/EXPRESS (confirmed against
buildingSMART/IFC5-development's own example files, e.g.
"Hello Wall/hello-wall.ifcx"). `data` is a flat array of {path, attributes,
children} assertions — the same path can appear multiple times, each
occurrence contributing more attributes/children, rather than one nested
tree built top-down.

This module covers only what's needed for a useful v1: spatial hierarchy
(via `children` maps — human-readable names are conveyed purely through
children-map keys, matching buildingSMART's own "Hello Wall" example, which
never attaches an explicit Name property to IfcProject/Site/Building/Storey
either), IFC class (`bsi::ifc::class`), body mesh geometry
(`usd::usdgeom::mesh`, always triangulated — no faceVertexCounts array was
observed in buildingSMART's own examples, implying an all-triangle
convention, unlike STEP's IfcIndexedPolygonalFace which accepts n-gons
directly), and flat properties under our own `converge::prop::<Name>`
namespace (NOT `bsi::ifc::prop::*` — that namespace is reserved for
buildingSMART-standard IFC attributes/quantities pre-declared in the
imported schema files, e.g. hello-wall.ifcx's own `bsi::ifc::prop::IsExternal`/
`Height`/`Volume` genuinely are real IFC4.3 attributes/quantities, not
arbitrary Pset properties. Our source parameters are raw, unvalidated
Revit/Tekla shared-parameter names — e.g. a German "Basisbauteil" — which
will essentially never appear in that standard catalog, and referencing an
undeclared `bsi::ifc::prop::*` key makes buildingSMART's reference viewer
fail with "Missing schema ... referenced by ...attributes". Using our own
namespace instead means WE own its schema, declared per distinct property
key actually used in this export — see _flatten_properties()/doc["schemas"]
below). Materials, type objects, quantities, element relationships, and the
4D schedule are intentionally out of scope for v1 — see
ifc/export.py::export_model for the mature IFC4X3 equivalent that includes
all of those.

Coordinates are emitted world-space (unit-scaled only, no
`usd::xformop` transform) — unlike export.py's centroid-local + IfcLocalPlacement
convention, since this export has no local-placement concept for v1.

Format/URIs may still change upstream since IFC5 is alpha; if buildingSMART
revises the standard schema URIs or the class-URI pattern, update
_STANDARD_IMPORTS/_class_uri below.
"""
import json
import logging
import uuid
from datetime import datetime, timezone

from ifc.schema import LENGTH_TO_M

logger = logging.getLogger(__name__)

_IFCX_VERSION = "ifcx_alpha"

# Our own namespace for raw/arbitrary source parameters — see module
# docstring for why these can't use the reserved bsi::ifc::prop:: namespace.
_CUSTOM_PROP_NS = "converge::prop::"

# Boilerplate buildingSMART schema imports, as seen verbatim in
# buildingSMART/IFC5-development's own example .ifcx files.
_STANDARD_IMPORTS = [
    {"uri": "https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx"},
    {"uri": "https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx"},
    {"uri": "https://ifcx.dev/@openusd.org/usd@v1.ifcx"},
]

# Same locale-aware truthy set as ifc/export.py::_TRUTHY_VALUES (kept local
# rather than imported since it's a private name of that module) — Revit
# boolean parameters render as whatever the source installation's UI
# language spells "yes" (e.g. German "Ja").
_TRUTHY_VALUES = frozenset({
    "true", "1", "yes",
    "ja", "wahr",
    "oui", "vrai",
    "sí", "si", "verdadero",
})


def _header(model_row: dict) -> dict:
    model_id = model_row.get("model_id") or model_row.get("stream_id") or "unknown"
    return {
        "id": f"converge/export/{model_id}.ifcx",
        "ifcxVersion": _IFCX_VERSION,
        "dataVersion": "1.0.0",
        "author": "bim-normalizer",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _class_uri(ifc_class: str) -> str:
    return f"https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/{ifc_class}"


def _synth_path(model_id: str, role: str) -> str:
    """Deterministic path for a synthesized container node (Project/Site/
    Building/Storey — no DB row backs these, unlike element prims which
    reuse their own element_id verbatim). Stable across re-exports of the
    same model_id so unchanged runs produce a diffable/comparable output."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{model_id}::{role}"))


def _unique_child_name(base: str, used: set) -> str:
    """A `children` map key must be unique within its parent's assertion.
    Element display names can collide (e.g. several elements named 'Wall')
    even though their underlying element_id path never does, so append a
    numeric suffix on repeat."""
    base = (base or "Element").strip() or "Element"
    name = base
    n = 2
    while name in used:
        name = f"{base}_{n}"
        n += 1
    used.add(name)
    return name


# ---------------------------------------------------------------------------
# Geometry (body mesh — always triangulated)
# ---------------------------------------------------------------------------

def _decode_faces(raw_faces: list) -> list[list[int]]:
    """Run-length encoded face list [n, i0, i1, ..., n, i0, i1, ...] -> list
    of 0-based index lists per face. Mirrors the same decode loop already
    used by ifc/export.py::_mesh_shape and ifc/geometry.py::_compute_area_
    from_faces (legacy Speckle encoding: 0=triangle, 1=quad; n>=3 is a real
    vertex count, i.e. a genuine n-gon)."""
    faces: list[list[int]] = []
    i = 0
    n_faces = len(raw_faces)
    while i < n_faces:
        try:
            raw_n = int(raw_faces[i])
        except (ValueError, TypeError):
            break
        n = raw_n if raw_n >= 3 else (3 if raw_n == 0 else 4)
        end = i + n + 1
        if n < 3 or end > n_faces:
            break
        try:
            indices = [int(raw_faces[i + 1 + k]) for k in range(n)]
        except (ValueError, TypeError):
            i = end
            continue
        faces.append(indices)
        i = end
    return faces


def _triangulate(faces: list[list[int]]) -> list[int]:
    """Fan-triangulate each (possibly n-gon) face into 0-based triangle
    index triples: (i0, ik, ik+1) for k in 1..n-2."""
    tri_indices: list[int] = []
    for face in faces:
        n = len(face)
        if n < 3:
            continue
        i0 = face[0]
        for k in range(1, n - 1):
            tri_indices.extend((i0, face[k], face[k + 1]))
    return tri_indices


def _mesh_points(mesh_data: dict, scale: float) -> list[list[float]] | None:
    """World-space, unit-scaled vertex list. Vertices may be stored as
    [[x,y,z],...] triplets or a flat [x,y,z,x,y,z,...] array (same detection
    as ifc/export.py::_mesh_shape)."""
    raw_verts = mesh_data.get("vertices") or []
    if not raw_verts:
        return None
    if isinstance(raw_verts[0], (list, tuple)):
        triplets = raw_verts
    else:
        triplets = [
            [raw_verts[i], raw_verts[i + 1], raw_verts[i + 2]]
            for i in range(0, len(raw_verts) - 2, 3)
        ]
    try:
        return [[float(v[0]) * scale, float(v[1]) * scale, float(v[2]) * scale] for v in triplets]
    except (IndexError, ValueError, TypeError) as exc:
        logger.debug("IFC5 export: mesh vertex parse error: %s", exc)
        return None


def _body_entries(element_path: str, mesh_data: dict | None, scale: float) -> list[dict]:
    """Assertions for this element's Body child prim (a triangulated
    usd::usdgeom::mesh), or [] when no usable mesh is stored — v1 has no
    bbox/axis/footprint fallback (STEP's _bbox_shape equivalent), so an
    element without mesh data simply gets no Body geometry."""
    if not mesh_data or not mesh_data.get("vertices") or not mesh_data.get("faces"):
        return []
    points = _mesh_points(mesh_data, scale)
    if not points or len(points) < 3:
        return []
    tri_indices = _triangulate(_decode_faces(mesh_data.get("faces") or []))
    if not tri_indices:
        return []
    n_points = len(points)
    if any(idx < 0 or idx >= n_points for idx in tri_indices):
        logger.debug("IFC5 export: mesh face index out of range for %s, skipping Body", element_path)
        return []

    body_path = f"{element_path}::Body"
    return [
        {"path": element_path, "children": {"Body": body_path}},
        {"path": body_path, "attributes": {"usd::usdgeom::mesh": {
            "points": points,
            "faceVertexIndices": tri_indices,
        }}},
    ]


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

def _coerce_value(raw, datatype: str):
    """Best-effort JSON-native coercion of a stored parameter value —
    .ifcx attributes are plain JSON values, not typed IFC value entities
    (no IfcLabel/IfcReal wrapper concept exists here, unlike
    ifc/export.py::_make_ifc_value)."""
    if raw is None:
        return None
    dt = (datatype or "string").lower()
    try:
        if dt in ("int", "integer"):
            return int(raw)
        if dt in ("float", "real", "double", "number", "measure"):
            return float(raw)
        if dt == "bool":
            return str(raw).strip().lower() in _TRUTHY_VALUES
    except (TypeError, ValueError):
        pass
    return str(raw)


def _datatype_name(value) -> str:
    """Python value -> the matching ifcx.tsp DataType enum name, for a
    schema declaration's {"value": {"dataType": ...}}. bool must be checked
    before int (bool is a subclass of int in Python)."""
    if isinstance(value, bool):
        return "Boolean"
    if isinstance(value, int):
        return "Integer"
    if isinstance(value, float):
        return "Real"
    return "String"


def _flatten_properties(params: list[dict], schema_registry: dict) -> dict:
    """{key: value} -> {"converge::prop::<key>": value}, flattened across
    all psets (the pset grouping itself has no v1 representation — if two
    different psets both define the same key, the later one wins).

    Also registers a schema declaration for each distinct property key the
    first time it's seen, into schema_registry (mutated in place — shared
    across all elements in one export, merged into the document's top-level
    "schemas" by the caller). Every attribute namespace referenced anywhere
    in "data" must resolve to a schema declared either here or in one of
    the imported schema files — see module docstring."""
    props = {}
    for p in params:
        key = (p.get("key") or "").strip()
        if not key:
            continue
        value = _coerce_value(p.get("value"), p.get("datatype"))
        if value is None:
            continue
        ns_key = f"{_CUSTOM_PROP_NS}{key}"
        props[ns_key] = value
        if ns_key not in schema_registry:
            schema_registry[ns_key] = {"value": {"dataType": _datatype_name(value)}}
    return props


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def export_model_ifcx(
    model_row: dict,
    elements: list[dict],
    params_by_element: dict[str, list],
    coord_unit: str = "mm",
) -> bytes:
    """
    EXPERIMENTAL — build an IFC5 (.ifcx) file from normalised model data.
    See module docstring for scope (hierarchy + class + body mesh +
    flat properties only).

    model_row, elements, params_by_element, coord_unit — same shapes as
    ifc/export.py::export_model (elements from bim_elements LEFT JOIN
    bim_geometry, params_by_element keyed by str(element_id)). Reuses that
    same query as-is (routers/ifc_export.py::_load_export_data) rather than
    a leaner one, so unused columns (bbox, axis, footprint) cost nothing
    today and are already available the moment this exporter grows to use
    them.
    """
    scale = LENGTH_TO_M.get((coord_unit or "mm").strip().lower(), LENGTH_TO_M["mm"])
    model_id = str(model_row.get("model_id") or model_row.get("stream_id") or "model")

    project_path = _synth_path(model_id, "project")
    site_path = _synth_path(model_id, "site")
    building_path = _synth_path(model_id, "building")

    data: list[dict] = [
        {"path": project_path, "attributes": {
            "bsi::ifc::class": {"code": "IfcProject", "uri": _class_uri("IfcProject")},
        }},
        {"path": project_path, "children": {"Site": site_path}},
        {"path": site_path, "attributes": {
            "bsi::ifc::class": {"code": "IfcSite", "uri": _class_uri("IfcSite")},
        }},
        {"path": site_path, "children": {"Building": building_path}},
        {"path": building_path, "attributes": {
            "bsi::ifc::class": {"code": "IfcBuilding", "uri": _class_uri("IfcBuilding")},
        }},
    ]

    unique_storeys = sorted({(e.get("storey") or "Level 0") for e in elements})
    storey_paths = {name: _synth_path(model_id, f"storey::{name}") for name in unique_storeys}

    data.append({"path": building_path, "children": {n: storey_paths[n] for n in unique_storeys}})
    for name in unique_storeys:
        data.append({"path": storey_paths[name], "attributes": {
            "bsi::ifc::class": {"code": "IfcBuildingStorey", "uri": _class_uri("IfcBuildingStorey")},
        }})

    storey_children: dict[str, dict[str, str]] = {name: {} for name in unique_storeys}
    used_names: dict[str, set] = {name: set() for name in unique_storeys}
    schema_registry: dict = {}
    element_count = 0

    for elem in elements:
        ifc_class = elem.get("ifc_class") or "IfcBuildingElementProxy"
        storey_key = elem.get("storey") or "Level 0"
        element_path = str(elem["element_id"])

        entry_attrs = {"bsi::ifc::class": {"code": ifc_class, "uri": _class_uri(ifc_class)}}
        elem_params = params_by_element.get(element_path, [])
        entry_attrs.update(_flatten_properties(elem_params, schema_registry))
        data.append({"path": element_path, "attributes": entry_attrs})

        data.extend(_body_entries(element_path, elem.get("mesh"), scale))

        child_name = _unique_child_name(elem.get("name") or ifc_class, used_names[storey_key])
        storey_children[storey_key][child_name] = element_path
        element_count += 1

    for name in unique_storeys:
        children = storey_children[name]
        if children:
            data.append({"path": storey_paths[name], "children": children})

    doc = {
        "header": _header(model_row),
        "imports": _STANDARD_IMPORTS,
        # Required top-level key per buildingSMART's own schema/ifcx.tsp
        # (IfcxFile.schemas has no `?`, unlike header/imports/data siblings) —
        # omitting it entirely crashes buildingSMART's reference viewer with
        # "Cannot convert undefined or null to object" (an unguarded
        # Object.keys(schemas)). Populated with one declaration per distinct
        # converge::prop::<Name> key actually used above — every attribute
        # namespace referenced in "data" must resolve to a schema declared
        # either here or in one of "imports"; an undeclared one instead
        # fails with "Missing schema ... referenced by ...attributes".
        "schemas": schema_registry,
        "data": data,
    }

    logger.info(
        "IFC5 (.ifcx) EXPERIMENTAL export: %d elements, %d storeys — model %s",
        element_count, len(unique_storeys), model_row.get("model_id"),
    )
    return json.dumps(doc, indent=2).encode("utf-8")
