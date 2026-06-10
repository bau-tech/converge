import logging
from typing import Any

from specklepy.objects import Base
from ifc.schema import length_to_m, MM2_TO_M2

logger = logging.getLogger(__name__)

_MESH_VERTEX_LIMIT = 30_000  # trim large meshes to avoid bloating JSONB


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
    dx = length_to_m(abs(bbox_max[0] - bbox_min[0]), units)
    dy = length_to_m(abs(bbox_max[1] - bbox_min[1]), units)
    dz = length_to_m(abs(bbox_max[2] - bbox_min[2]), units)
    return dx * dy * dz


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
    units = getattr(obj, "units", "mm") or "mm"

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
            return {
                "bbox_min": bmin,
                "bbox_max": bmax,
                "centroid": _centroid(bmin, bmax),
                "volume_m3": _bbox_volume_m3(bmin, bmax, units),
                "area_m2": None,
                "mesh": None,
            }
        except Exception:
            return None

    try:
        pts = _vertices_to_triples(vertices_flat)
        if not pts:
            return None

        bbox_min, bbox_max = _compute_bbox(pts)
        centroid = _centroid(bbox_min, bbox_max)
        volume_m3 = (
            _compute_volume_from_mesh(pts, faces, units)
            or _bbox_volume_m3(bbox_min, bbox_max, units)
        )
        area_m2 = _compute_area_from_faces(pts, faces, units)

        # Trim to storage limit, remove faces that reference truncated vertices
        trimmed_pts = pts[:_MESH_VERTEX_LIMIT]
        if len(pts) > _MESH_VERTEX_LIMIT:
            logger.debug("Mesh truncated from %d to %d vertices for object %s",
                         len(pts), _MESH_VERTEX_LIMIT, getattr(obj, "id", "?"))
        valid_faces = _filter_faces(list(faces), len(trimmed_pts))
        # Store vertices as list of [x,y,z] triplets (compact, matches export parser)
        mesh_json = {"vertices": trimmed_pts, "faces": valid_faces} if trimmed_pts else None

        return {
            "bbox_min": bbox_min,
            "bbox_max": bbox_max,
            "centroid": centroid,
            "volume_m3": volume_m3,
            "area_m2": area_m2,
            "mesh": mesh_json,
        }
    except Exception as e:
        obj_id = getattr(obj, "id", "unknown")
        logger.debug("Geometry extraction failed for %s: %s", obj_id, e)
        return None


def _compute_volume_from_mesh(pts: list, faces: list, units: str) -> float | None:
    """
    Signed-volume sum (divergence theorem) over triangulated faces.
    Accurate for closed, watertight meshes. Returns None if the mesh sums to zero
    (open/degenerate mesh), so the caller can fall back to a bbox estimate.
    """
    if not faces or len(pts) < 4:
        return None
    try:
        total = 0.0
        i = 0
        n_pts = len(pts)
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
            p0 = pts[idx0]
            for j in range(2, n):
                idx1 = face_list[i + j]
                idx2 = face_list[i + j + 1]
                if idx1 >= n_pts or idx2 >= n_pts:
                    continue
                p1 = pts[idx1]
                p2 = pts[idx2]
                total += (
                    p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
                    + p0[1] * (p1[2] * p2[0] - p1[0] * p2[2])
                    + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])
                )
            i = end
        if total == 0.0:
            return None
        factor = length_to_m(1.0, units) ** 3
        return abs(total) / 6.0 * factor
    except Exception:
        return None


def _compute_area_from_faces(pts: list, faces: list, units: str) -> float | None:
    """Approximate surface area by summing triangle areas from face list."""
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

        # Convert from source units² to m²
        u = (units or "mm").lower()
        factors = {"mm": MM2_TO_M2, "cm": 1e-4, "m": 1.0, "in": 6.4516e-4, "ft": 0.092903}
        return total * factors.get(u, MM2_TO_M2)
    except Exception:
        return None
