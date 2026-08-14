import logging
from typing import Any

from specklepy.objects import Base
from ifc.schema import LENGTH_TO_M, length_to_m, sanitize_float, sanitize_floats

logger = logging.getLogger(__name__)

_MESH_VERTEX_LIMIT = 30_000  # trim large meshes to avoid bloating JSONB


def _sanitize_geo_values(obj, **values: dict) -> dict:
    """
    Run sanitize_float/sanitize_floats over a dict of geometry values
    (bbox_min, bbox_max, centroid, etc.), logging once if any value was
    actually non-finite (NaN/Inf) and had to be dropped to None.
    """
    sanitized = {}
    changed_keys = []
    for key, val in values.items():
        new_val = sanitize_floats(val) if isinstance(val, list) else sanitize_float(val)
        if new_val != val:
            changed_keys.append(key)
        sanitized[key] = new_val
    if changed_keys:
        logger.warning(
            "extract_geometry: non-finite value(s) sanitized to None for object %s (type=%s): %s",
            getattr(obj, "id", "?"), getattr(obj, "speckle_type", "?"), sorted(changed_keys),
        )
    return sanitized


def _decode_face_count(n: int) -> int:
    """
    Normalise Speckle face-count encoding.

    Legacy Speckle connector format (Revit connector v2.x):
      0 → triangle  (3 vertices)
      1 → quad      (4 vertices)

    Current format: n is already the actual vertex count (≥3).
    """
    if n == 0:
        return 3
    if n == 1:
        return 4
    return n


def _get_display_value(obj: Base):
    """
    Return the displayValue of a Speckle object, handling both
    'displayValue' and '@displayValue' (detachable attribute) names.
    """
    dv = getattr(obj, "displayValue", None)
    if dv is None:
        # Try the detachable form directly — some specklepy versions don't
        # transparently alias @-prefixed keys through __getattr__
        try:
            dv = obj["@displayValue"]
        except Exception:
            pass
    return dv


def _vertices_to_triples(vertices: list) -> list[list[float]]:
    """Convert a flat [x,y,z,x,y,z,...] array to [[x,y,z], ...] triplets.
    Silently skips non-numeric items (e.g. un-dechunked DataChunk objects)."""
    pts = []
    for i in range(0, len(vertices) - 2, 3):
        try:
            pts.append([float(vertices[i]), float(vertices[i+1]), float(vertices[i+2])])
        except (TypeError, ValueError):
            pass
    return pts


def _compute_bbox(points: list[list[float]]) -> tuple[list[float], list[float]]:
    if not points:
        raise ValueError("Cannot compute bbox of empty point list")
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    zs = [p[2] for p in points]
    return (
        [min(xs), min(ys), min(zs)],
        [max(xs), max(ys), max(zs)],
    )


def _centroid(bbox_min: list, bbox_max: list) -> list[float]:
    return [
        (bbox_min[0] + bbox_max[0]) / 2,
        (bbox_min[1] + bbox_max[1]) / 2,
        (bbox_min[2] + bbox_max[2]) / 2,
    ]


def _bbox_volume_m3(bbox_min: list, bbox_max: list, units: str) -> float:
    factor = _plausible_length_factor(bbox_min, bbox_max, units)
    dx = abs(bbox_max[0] - bbox_min[0]) * factor
    dy = abs(bbox_max[1] - bbox_min[1]) * factor
    dz = abs(bbox_max[2] - bbox_min[2]) * factor
    return dx * dy * dz


def _bbox_area_m2(bbox_min: list, bbox_max: list, units: str) -> float:
    """Total surface area of the bounding box — extract_geometry's no-mesh
    fallback estimate, and the fallback when mesh-derived area is
    implausible (see _plausible_length_factor)."""
    factor = _plausible_length_factor(bbox_min, bbox_max, units)
    dx = abs(bbox_max[0] - bbox_min[0]) * factor
    dy = abs(bbox_max[1] - bbox_min[1]) * factor
    dz = abs(bbox_max[2] - bbox_min[2]) * factor
    return 2 * (dx * dy + dy * dz + dx * dz)


# Plausible single-BIM-element bounding-box diagonal range, in metres: from
# 1cm (a small fitting) to 300m (a large roof/site slab) — deliberately wide,
# this only needs to separate "obviously already metres" from "obviously not."
_PLAUSIBLE_BBOX_DIAGONAL_M = (0.01, 300.0)


def _plausible_length_factor(bbox_min: list, bbox_max: list, units: str) -> float:
    """Like length_to_m(1.0, units), but cross-checked against the object's
    own raw (unconverted) bbox diagonal — confirmed via a live ingest of a
    native-IFC-imported Speckle commit that a leaf object's own `units`
    metadata can disagree with the actual scale of its coordinates: walls
    were correctly tagged "m", but door/window/furniture objects were tagged
    "mm" despite their raw mesh coordinates already being in metres (a
    46cm-wide door's raw, unconverted bbox was already ~0.47, not ~470).
    Applying the declared mm->m factor on top of already-metre-scale
    coordinates silently produced volumes/areas ~1e9x/1e6x too small instead
    of erroring.

    A real building element's raw bbox diagonal is never plausible as
    millimetres if it's already under ~1 in its raw scale (a "1mm door"
    doesn't exist), so: if the declared unit's factor is not already 1.0
    (metres) but the RAW, unconverted diagonal already falls in a plausible
    metre range, trust the raw scale over the declared unit."""
    declared_factor = length_to_m(1.0, units)
    if declared_factor == 1.0:
        return declared_factor
    raw_diag = sum((bbox_max[i] - bbox_min[i]) ** 2 for i in range(3)) ** 0.5
    lo, hi = _PLAUSIBLE_BBOX_DIAGONAL_M
    if lo <= raw_diag <= hi:
        return 1.0
    return declared_factor


def _get_transform_matrix(transform_obj) -> list | None:
    """Extract a flat 16-float row-major matrix from a Speckle transform."""
    if transform_obj is None:
        return None
    if isinstance(transform_obj, (list, tuple)) and len(transform_obj) >= 12:
        try:
            return [float(v) for v in transform_obj[:16]]
        except (TypeError, ValueError):
            return None
    matrix = getattr(transform_obj, "matrix", None)
    if matrix and isinstance(matrix, (list, tuple)) and len(matrix) >= 12:
        try:
            return [float(v) for v in matrix[:16]]
        except (TypeError, ValueError):
            return None
    return None


def _apply_transform_matrix(vertices_flat: list, matrix: list) -> list:
    """
    Apply a 4x4 row-major transform matrix to a flat [x,y,z,...] vertex list.
    Row layout: [m00 m01 m02 m03 | m10 m11 m12 m13 | m20 m21 m22 m23 | ...]
    """
    m = matrix
    result = []
    for i in range(0, len(vertices_flat) - 2, 3):
        try:
            x, y, z = float(vertices_flat[i]), float(vertices_flat[i+1]), float(vertices_flat[i+2])
            result.append(m[0]*x + m[1]*y + m[2]*z + m[3])
            result.append(m[4]*x + m[5]*y + m[6]*z + m[7])
            result.append(m[8]*x + m[9]*y + m[10]*z + m[11])
        except (TypeError, ValueError, IndexError):
            result.extend(vertices_flat[i:i+3])
    return result


def _has_numeric_vertices(m: Base) -> bool:
    """Return True if m carries a usable flat-float vertex array."""
    verts = getattr(m, "vertices", None) or getattr(m, "@vertices", None)
    if not verts or not isinstance(verts, (list, tuple)) or len(verts) < 9:
        return False
    try:
        float(verts[0])
        return True
    except (TypeError, ValueError):
        return False  # DataChunks not yet assembled


def _get_all_meshes(obj: Base, _depth: int = 0, _instance_defs: dict | None = None) -> list:
    """
    Return all mesh-like Base objects that carry vertex/face data.

    Traversal order:
      1. obj.displayValue  (or @displayValue)
         - InstanceProxy items are resolved via _instance_defs with transform applied
         - Non-mesh items (Brep, surface wrapper) are recursed into
      2. obj.definition fallback for v3 Revit family instances
      3. obj.renderMesh fallback for older connectors
    """
    if _depth > 2:
        return []

    result: list[Base] = []

    dv = _get_display_value(obj)
    if dv is not None:
        if not isinstance(dv, list):
            dv = [dv]
        for item in dv:
            if not isinstance(item, Base):
                continue
            st = getattr(item, "speckle_type", "") or ""
            if "InstanceProxy" in st and _instance_defs is not None:
                # v3 Revit: resolve instance → definition geometry with transform
                defn_id = str(getattr(item, "definitionId", "") or "")
                defn = _instance_defs.get(defn_id)
                if defn is not None:
                    matrix = _get_transform_matrix(getattr(item, "transform", None))
                    defn_meshes = _get_all_meshes(defn, _depth + 1, _instance_defs)
                    for dm in defn_meshes:
                        verts = list(
                            getattr(dm, "vertices", None)
                            or getattr(dm, "@vertices", None)
                            or []
                        )
                        faces = list(
                            getattr(dm, "faces", None)
                            or getattr(dm, "@faces", None)
                            or []
                        )
                        if verts:
                            synthetic = Base()
                            synthetic.vertices = _apply_transform_matrix(verts, matrix) if matrix else verts
                            synthetic.faces = faces
                            result.append(synthetic)
                continue
            if _has_numeric_vertices(item):
                result.append(item)
            else:
                # Not a direct mesh — could be Brep, surface wrapper, etc.
                # Recurse into its own displayValue for the tessellation.
                inner = _get_all_meshes(item, _depth + 1, _instance_defs)
                result.extend(inner)

    # v3 InstanceDefinitionProxy stores geometry in 'objects', not 'displayValue'
    # Items can be resolved Base objects OR string IDs that need lookup in _instance_defs.
    if not result:
        obj_list = getattr(obj, "objects", None)
        if obj_list and isinstance(obj_list, list):
            for o in obj_list:
                if isinstance(o, Base):
                    if _has_numeric_vertices(o):
                        result.append(o)
                    else:
                        result.extend(_get_all_meshes(o, _depth + 1, _instance_defs))
                elif isinstance(o, str) and _instance_defs:
                    resolved = _instance_defs.get(o)
                    if resolved is not None:
                        if _has_numeric_vertices(resolved):
                            result.append(resolved)
                        else:
                            result.extend(_get_all_meshes(resolved, _depth + 1, _instance_defs))

    # v3 Revit connector instance/definition split: structural family instances
    # (beams, columns) have displayValue=null; geometry lives on obj.definition.
    if not result:
        defn = getattr(obj, "definition", None)
        if isinstance(defn, Base):
            result.extend(_get_all_meshes(defn, _depth + 1, _instance_defs))

    # renderMesh fallback — used by some older Revit/IFC connectors
    if not result:
        rm = getattr(obj, "renderMesh", None)
        if rm is not None:
            if not isinstance(rm, list):
                rm = [rm]
            for m in rm:
                if isinstance(m, Base) and _has_numeric_vertices(m):
                    result.append(m)

    return result


def _merge_meshes(meshes: list) -> tuple[list, list] | tuple[None, None]:
    """
    Merge multiple Speckle meshes into a single flat (vertices, faces) pair.
    Vertices: flat [x,y,z,x,y,z,...].  Faces: run-length [n,i0,i1,...] with
    indices offset per sub-mesh so the combined list stays consistent.

    Handles both current (n=actual count) and legacy (0=tri, 1=quad) face formats.
    """
    all_vertices: list = []
    all_faces: list = []
    vertex_offset = 0

    for mesh in meshes:
        # Accept both 'vertices' and '@vertices' (detachable)
        verts = list(getattr(mesh, "vertices", None) or getattr(mesh, "@vertices", None) or [])
        faces = list(getattr(mesh, "faces", None) or getattr(mesh, "@faces", None) or [])
        if not verts:
            continue
        all_vertices.extend(verts)
        # Re-index faces with vertex offset; normalise legacy face encoding
        i = 0
        while i < len(faces):
            try:
                raw_n = int(faces[i])
            except (ValueError, TypeError):
                break
            n = _decode_face_count(raw_n)
            end = i + n + 1
            if n < 3 or end > len(faces):
                i = end
                continue
            try:
                indices = [int(faces[i + 1 + k]) + vertex_offset for k in range(n)]
            except (ValueError, TypeError):
                i = end
                continue
            all_faces.append(n)
            all_faces.extend(indices)
            i = end
        vertex_offset += len(verts) // 3

    return (all_vertices, all_faces) if all_vertices else (None, None)


def _filter_faces(face_list: list, max_vertex_idx: int) -> list:
    """
    Return a face list with any polygon removed if any of its vertex indices
    fall outside [0, max_vertex_idx). Preserves the n + indices encoding.
    Handles both current and legacy (0=tri, 1=quad) Speckle face formats.
    """
    result = []
    i = 0
    while i < len(face_list):
        try:
            raw_n = int(face_list[i])
        except (IndexError, ValueError, TypeError):
            break
        n = _decode_face_count(raw_n)
        end = i + n + 1
        if n < 3 or end > len(face_list):
            i = end
            continue
        indices = face_list[i + 1: end]
        if all(0 <= idx < max_vertex_idx for idx in indices):
            result.append(n)          # store normalised count
            result.extend(indices)
        i = end
    return result


def extract_geometry(obj: Base, instance_defs: dict | None = None) -> dict | None:
    """
    Extract bbox, centroid, volume, area and trimmed mesh from a Speckle object.
    Merges all displayValue sub-meshes (important for Tekla steel profiles which
    have one mesh per face).  Returns None if no geometry is available.
    instance_defs — map of id → InstanceDefinitionProxy for v3 instance resolution.
    """
    _raw_units = getattr(obj, "units", None)
    units = _raw_units or "mm"
    if not _raw_units:
        logger.warning(
            "extract_geometry: no units on object id=%s type=%s — defaulting to mm",
            getattr(obj, "id", "?"), getattr(obj, "speckle_type", "?"),
        )

    meshes = _get_all_meshes(obj, _instance_defs=instance_defs)
    vertices_flat, faces = _merge_meshes(meshes)  # flat [x,y,z,...] + run-length faces

    if not vertices_flat:
        # Fallback: bbox attribute on the object itself
        bbox = getattr(obj, "bbox", None)
        if bbox is None:
            return None
        try:
            bmin = [float(bbox.get("x", {}).get("min", 0)),
                    float(bbox.get("y", {}).get("min", 0)),
                    float(bbox.get("z", {}).get("min", 0))]
            bmax = [float(bbox.get("x", {}).get("max", 0)),
                    float(bbox.get("y", {}).get("max", 0)),
                    float(bbox.get("z", {}).get("max", 0))]
            centroid = _centroid(bmin, bmax)
            geo = _sanitize_geo_values(
                obj,
                bbox_min=bmin,
                bbox_max=bmax,
                centroid=centroid,
                centroid_si=[length_to_m(c, units) for c in centroid],
                volume_m3=_bbox_volume_m3(bmin, bmax, units),
                area_m2=None,
            )
            geo["mesh"] = None
            return geo
        except Exception:
            return None

    try:
        pts = _vertices_to_triples(vertices_flat)
        if not pts:
            return None

        bbox_min, bbox_max = _compute_bbox(pts)
        centroid = _centroid(bbox_min, bbox_max)

        # Resolved once here (cross-checked against this object's own raw
        # bbox — see _plausible_length_factor) and reused for both volume and
        # area, rather than each independently re-deriving a conversion
        # factor from the (possibly wrong) `units` string.
        length_factor = _plausible_length_factor(bbox_min, bbox_max, units)
        if length_factor != length_to_m(1.0, units):
            logger.warning(
                "extract_geometry: object %s declares units=%r but its raw bbox diagonal "
                "looks like it's already in metres — treating as metres instead of trusting "
                "the declared unit for volume/area",
                getattr(obj, "id", "?"), units,
            )

        volume_m3 = (
            _compute_volume_from_mesh(pts, faces, length_factor)
            or _bbox_volume_m3(bbox_min, bbox_max, units)
        )
        area_m2 = _compute_area_from_faces(pts, faces, length_factor)

        # Trim to storage limit, remove faces that reference truncated vertices
        trimmed_pts = pts[:_MESH_VERTEX_LIMIT]
        if len(pts) > _MESH_VERTEX_LIMIT:
            logger.debug("Mesh truncated from %d to %d vertices for object %s",
                         len(pts), _MESH_VERTEX_LIMIT, getattr(obj, "id", "?"))
        valid_faces = _filter_faces(list(faces), len(trimmed_pts))
        # Store vertices as list of [x,y,z] triplets (compact, matches export parser)
        if valid_faces:
            mesh_json = {"vertices": trimmed_pts, "faces": valid_faces}
        else:
            mesh_json = None
            if faces:
                logger.warning(
                    "extract_geometry: mesh truncation left 0 valid faces for object %s (type=%s) — "
                    "falling back to bbox-only shape (bbox/volume/area unaffected)",
                    getattr(obj, "id", "?"), getattr(obj, "speckle_type", "?"),
                )

        geo = _sanitize_geo_values(
            obj,
            bbox_min=bbox_min,
            bbox_max=bbox_max,
            centroid=centroid,
            centroid_si=[length_to_m(c, units) for c in centroid],
            volume_m3=volume_m3,
            area_m2=area_m2,
        )
        geo["mesh"] = mesh_json
        return geo
    except Exception as e:
        obj_id = getattr(obj, "id", "unknown")
        logger.debug("Geometry extraction failed for %s: %s", obj_id, e)
        return None


# ---------------------------------------------------------------------------
# Axis / footprint extraction — structural centerline + plan contour, for the
# IFC exporter's Axis/FootPrint IfcShapeRepresentations (ifc/export.py). Kept
# independent of extract_geometry() above (own function, called separately by
# pipeline/normalize.py) so a failure here never affects mesh/bbox extraction.
#
# Two sources, preferred in this order:
#   1. Bespoke structural metadata this connector fork writes on send — richer
#      and more current than the generic attribute below. Revit nests it under
#      obj.properties["Structural"] (startPointMm/endPointMm, or
#      insertionPointMm for point-placed columns, or contours for floor/slab
#      sketches — see StructuralPropertiesExtractor.cs). Tekla writes flat
#      obj.properties["startPoint"]/["endPoint"]/["contourPoints"] instead
#      (ClassPropertyExtractor.cs).
#   2. The generic Speckle `location` attribute every BIM object carries:
#      Point (+rotation) for columns, Line for beams/walls, closed Polycurve
#      for slabs.
# Revit's *Mm fields are unconditionally in millimetres regardless of the
# object's own units (unlike everything else this file stores, which is kept
# in the object's own raw units) — _mm_to_units() converts them to match.
# ---------------------------------------------------------------------------

def _mm_to_units(value_mm: float, units: str) -> float:
    """Convert a value that's unconditionally in millimetres (Revit's
    Structural.*Mm fields) into the object's own native units."""
    u = (units or "mm").strip().lower()
    factor = LENGTH_TO_M.get(u, LENGTH_TO_M["mm"])
    return value_mm * (LENGTH_TO_M["mm"] / factor)


def _read_point_like(pt) -> list[float] | None:
    """Read [x,y,z] from either a plain {"x","y","z"} dict (Revit's *Mm
    fields, built as raw C# Dictionary<string,object> and so deserialized as
    plain dicts) or a real specklepy Point-like object (obj.location, Tekla's
    startPoint/endPoint, Arc segment endpoints)."""
    if pt is None:
        return None
    if isinstance(pt, dict):
        x, y, z = pt.get("x"), pt.get("y"), pt.get("z")
    else:
        x, y, z = getattr(pt, "x", None), getattr(pt, "y", None), getattr(pt, "z", None)
    if x is None or y is None or z is None:
        return None
    try:
        return [float(x), float(y), float(z)]
    except (TypeError, ValueError):
        return None


def _polycurve_to_points(polycurve) -> list[list[float]]:
    """
    Flatten a Speckle Polycurve's segments into an ordered list of loop
    points, in the polycurve's own (already-typed-object) units:
      - Line segments contribute their start point (segment joins share a
        point, so only one copy is kept per join).
      - Arc segments are sampled at start/mid/end (3 points) rather than
        flattened to a chord.
      - A generic NURBS Curve segment prefers its tessellated `displayValue`
        polyline when present; otherwise falls back to its first/last
        control point as a documented approximation (not a precise curve
        endpoint in the periodic/non-clamped case, but the closest cheap
        estimate without a real NURBS evaluator).
    Unrecognized segment types are skipped (graceful degrade, matches this
    file's existing style elsewhere).
    """
    points: list[list[float]] = []

    def _append(pt):
        if isinstance(pt, (list, tuple)) and len(pt) >= 3:
            try:
                p = [float(pt[0]), float(pt[1]), float(pt[2])]
            except (TypeError, ValueError):
                return
        else:
            p = _read_point_like(pt)
        if p and (not points or p != points[-1]):
            points.append(p)

    for seg in (getattr(polycurve, "segments", None) or []):
        st = getattr(seg, "speckle_type", "") or ""
        if "Arc" in st:
            _append(getattr(seg, "startPoint", None))
            _append(getattr(seg, "midPoint", None))
            _append(getattr(seg, "endPoint", None))
        elif "Line" in st:
            _append(getattr(seg, "start", None))
        elif "Curve" in st:
            display = getattr(seg, "displayValue", None)
            sampled = False
            verts = getattr(display, "value", None) or getattr(display, "points", None) if display is not None else None
            if verts:
                triples = verts if (verts and isinstance(verts[0], (list, tuple))) else _vertices_to_triples(list(verts))
                for t in triples:
                    _append(t)
                sampled = True
            if not sampled:
                ctrl = getattr(seg, "points", None) or []
                if len(ctrl) >= 6 and not isinstance(ctrl[0], (list, tuple)):
                    _append(list(ctrl[0:3]))
                    _append(list(ctrl[-3:]))
        else:
            logger.debug("_polycurve_to_points: unrecognized segment type %r skipped", st)

    return points


def _axis_from_structural(structural: dict, units: str, bbox_min, bbox_max) -> list[list[float]] | None:
    start_mm = structural.get("startPointMm")
    end_mm = structural.get("endPointMm")
    if start_mm and end_mm:
        p0, p1 = _read_point_like(start_mm), _read_point_like(end_mm)
        if p0 and p1:
            return [[_mm_to_units(c, units) for c in p0], [_mm_to_units(c, units) for c in p1]]

    ins_mm = structural.get("insertionPointMm")
    if ins_mm and bbox_min and bbox_max and len(bbox_min) > 2 and len(bbox_max) > 2:
        p = _read_point_like(ins_mm)
        if p:
            x, y = _mm_to_units(p[0], units), _mm_to_units(p[1], units)
            return [[x, y, float(bbox_min[2])], [x, y, float(bbox_max[2])]]

    return None


def _footprint_from_structural(structural: dict) -> list[list[list[float]]] | None:
    """Structural.contours is a list of Polycurve loops (outer boundary +
    inner holes, from Revit's floor.SketchId -> Sketch.Profile) — already in
    the object's own units (typed Speckle geometry, not a raw *Mm field)."""
    contours = structural.get("contours")
    if not contours:
        return None
    loops = []
    for pc in contours:
        pts = _polycurve_to_points(pc)
        if len(pts) >= 3:
            loops.append(pts)
    return loops or None


def _axis_from_tekla_properties(properties: dict) -> list[list[float]] | None:
    p0 = _read_point_like(properties.get("startPoint"))
    p1 = _read_point_like(properties.get("endPoint"))
    return [p0, p1] if p0 and p1 else None


def _footprint_from_tekla_properties(properties: dict) -> list[list[list[float]]] | None:
    raw_pts = properties.get("contourPoints")
    if not raw_pts:
        return None
    pts = [p for p in (_read_point_like(item) for item in raw_pts) if p]
    return [pts] if len(pts) >= 3 else None


def _axis_from_location(location, units: str, bbox_min, bbox_max) -> list[list[float]] | None:
    st = getattr(location, "speckle_type", "") or ""
    if "Line" in st:
        p0 = _read_point_like(getattr(location, "start", None))
        p1 = _read_point_like(getattr(location, "end", None))
        if p0 and p1:
            return [p0, p1]
    elif "Point" in st:
        p = _read_point_like(location)
        if p and bbox_min and bbox_max and len(bbox_min) > 2 and len(bbox_max) > 2:
            return [[p[0], p[1], float(bbox_min[2])], [p[0], p[1], float(bbox_max[2])]]
    return None


def _footprint_from_location(location) -> list[list[list[float]]] | None:
    st = getattr(location, "speckle_type", "") or ""
    if "Polycurve" not in st or not getattr(location, "closed", False):
        return None
    pts = _polycurve_to_points(location)
    return [pts] if len(pts) >= 3 else None


def _sanitize_point_list(points: list[list[float]] | None) -> list[list[float]] | None:
    """Drop a whole point (not just the bad coordinate) if any of its
    coordinates is non-finite — stricter than sanitize_floats' per-element
    None-in-place behavior, since a partially-None point would otherwise
    corrupt an IfcCartesianPoint downstream."""
    if not points:
        return None
    clean = []
    for p in points:
        sp = sanitize_floats(p)
        if sp is not None and all(v is not None for v in sp):
            clean.append(sp)
    return clean or None


def extract_axis_footprint(obj: Base, bbox_min: list | None, bbox_max: list | None) -> dict | None:
    """
    Structural centerline (axis) and plan contour (footprint) for the IFC
    exporter's Axis/FootPrint representations — enrichment on top of
    extract_geometry(), not required. Returns None, or
    {"axis": {"points": [[x,y,z],[x,y,z]]} | None,
     "footprint": {"loops": [[[x,y,z],...], ...]} | None}
    in the object's own raw units (same convention as bbox_min/mesh — NOT SI).
    This dict-wrapped shape (rather than bare lists) is what gets stored
    verbatim in bim_geometry.axis/.footprint and is what ifc/export.py's
    _axis_shape()/_footprint_shape() read back.

    bbox_min/bbox_max should be this same object's own already-computed bbox
    (from extract_geometry(), same call) — used only for the column
    Point-insertion axis fallback (extrudes the insertion point through the
    object's own bbox Z-range, since bim-normalizer has no storey-elevation
    table to derive a true base/top-level axis from). Pass None to skip that
    fallback (column axis simply won't be extracted).
    """
    units = getattr(obj, "units", None) or "mm"
    properties = getattr(obj, "properties", None)
    if not isinstance(properties, dict):
        properties = None
    structural = properties.get("Structural") if properties else None
    if not isinstance(structural, dict):
        structural = None

    axis = None
    footprint = None

    if structural:
        axis = _axis_from_structural(structural, units, bbox_min, bbox_max)
        footprint = _footprint_from_structural(structural)
    if axis is None and properties:
        axis = _axis_from_tekla_properties(properties)
    if footprint is None and properties:
        footprint = _footprint_from_tekla_properties(properties)

    location = getattr(obj, "location", None)
    if location is not None:
        if axis is None:
            try:
                axis = _axis_from_location(location, units, bbox_min, bbox_max)
            except Exception as exc:
                logger.debug("extract_axis_footprint: axis-from-location failed for %s: %s",
                             getattr(obj, "id", "?"), exc)
        if footprint is None:
            try:
                footprint = _footprint_from_location(location)
            except Exception as exc:
                logger.debug("extract_axis_footprint: footprint-from-location failed for %s: %s",
                             getattr(obj, "id", "?"), exc)

    axis = _sanitize_point_list(axis)
    if axis is not None and len(axis) < 2:
        axis = None
    if footprint is not None:
        footprint = [loop for loop in (_sanitize_point_list(l) for l in footprint) if loop and len(loop) >= 3]
        footprint = footprint or None

    if axis is None and footprint is None:
        return None
    return {
        "axis": {"points": axis} if axis else None,
        "footprint": {"loops": footprint} if footprint else None,
    }


def _compute_volume_from_mesh(pts: list, faces: list, length_factor: float) -> float | None:
    """
    Signed-volume sum (divergence theorem) over triangulated faces.
    Accurate for closed, watertight meshes. Returns None if the mesh sums to zero
    (open/degenerate mesh), so the caller can fall back to a bbox estimate.

    `length_factor` (raw-units-to-metres) is resolved by the caller via
    _plausible_length_factor rather than a bare length_to_m(1.0, units) here —
    see that function's docstring for why a per-object `units` string alone
    isn't trustworthy for this codebase's Speckle-IFC-imported data.

    Points are recentered around their own first vertex before summing. The
    origin-referenced tetrahedron-sum formula below is mathematically exact
    regardless of reference point, but for real-world/survey-coordinate BIM
    projects — vertices at e.g. ~6-7-digit UTM/Gauss-Krüger eastings/
    northings rather than near (0,0,0), common for georeferenced
    civil/structural models — summing the raw, un-recentered coordinates
    hits catastrophic floating-point cancellation (the individual product
    terms are ~(1e6)^3 while the true volume is orders of magnitude
    smaller) and produces wildly wrong volumes. Confirmed live: a single
    ArchiCAD wall at ~689,257/5,340,293 easting/northing with a true volume
    of ~4.7 m³ computed as ~930,000 m³ before this fix — 98.6% of a whole
    model's reported total_volume_m3 from one element. Recentering keeps
    every term near the object's own (small) scale instead; not needed for
    _compute_area_from_faces below, which only ever sums edge-difference
    vectors (already small local values) rather than raw absolute positions.
    """
    if not faces or len(pts) < 4:
        return None
    try:
        ref = pts[0]
        local_pts = [[p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]] for p in pts]
        total = 0.0
        i = 0
        n_pts = len(local_pts)
        face_list = list(faces)
        while i < len(face_list):
            raw_n = face_list[i]
            n = _decode_face_count(raw_n)
            end = i + n + 1
            if n < 3 or end > len(face_list):
                i = end
                continue
            idx0 = face_list[i + 1]
            if idx0 >= n_pts:
                i = end
                continue
            p0 = local_pts[idx0]
            for j in range(2, n):
                idx1 = face_list[i + j]
                idx2 = face_list[i + j + 1]
                if idx1 >= n_pts or idx2 >= n_pts:
                    continue
                p1 = local_pts[idx1]
                p2 = local_pts[idx2]
                total += (
                    p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
                    + p0[1] * (p1[2] * p2[0] - p1[0] * p2[2])
                    + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])
                )
            i = end
        if total == 0.0:
            return None
        return abs(total) / 6.0 * (length_factor ** 3)
    except Exception:
        return None


def _compute_area_from_faces(pts: list, faces: list, length_factor: float) -> float | None:
    """Approximate surface area by summing triangle areas from face list.
    See _compute_volume_from_mesh's docstring re: `length_factor`."""
    if not faces or len(pts) < 3:
        return None

    try:
        total = 0.0
        i = 0
        face_list = list(faces)
        n_pts = len(pts)
        while i < len(face_list):
            raw_n = face_list[i]
            n = _decode_face_count(raw_n)
            end = i + n + 1
            if n < 3 or end > len(face_list):
                i = end
                continue
            # Fan triangulation from first vertex
            idx0 = face_list[i + 1]
            if idx0 >= n_pts:
                i = end
                continue
            p0 = pts[idx0]
            for j in range(2, n):
                idx1 = face_list[i + j]
                idx2 = face_list[i + j + 1]
                if idx1 >= n_pts or idx2 >= n_pts:
                    continue
                p1 = pts[idx1]
                p2 = pts[idx2]
                # Cross product magnitude / 2
                ax, ay, az = p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]
                bx, by, bz = p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]
                cx = ay*bz - az*by
                cy = az*bx - ax*bz
                cz = ax*by - ay*bx
                total += (cx*cx + cy*cy + cz*cz) ** 0.5 / 2
            i = end

        return total * (length_factor ** 2)
    except Exception:
        return None
