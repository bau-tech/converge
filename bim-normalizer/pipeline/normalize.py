import logging
import time
from typing import Any

from config.settings import SPECKLE_SERVER_URL, SPECKLE_TOKEN
from db.connection import get_conn, release_conn
from db.insert import (
    upsert_model,
    upsert_element,
    upsert_geometry,
    extract_and_upsert_parameters,
)
from ifc.classify import classify_element, compute_element_hash
from ifc.geometry import extract_geometry
from ifc.schema import length_to_m
from ifc.spatial import get_storey, get_application_id
from speckle.fetch import fetch_commit, flatten_elements, detect_source, collect_instance_definitions, build_object_map

logger = logging.getLogger(__name__)


def ingest_commit(
    stream_id: str,
    commit_id: str,
    token: str | None = None,
    server_url: str | None = None,
    forced_source: str | None = None,
) -> dict[str, Any]:
    """
    Full pipeline: receive Speckle commit → normalise → persist.

    Returns:
        {model_id, element_count, skipped_count, duration_s}
    """
    t0 = time.monotonic()
    token = token or SPECKLE_TOKEN
    resolved_server_url = (server_url or SPECKLE_SERVER_URL).rstrip("/")

    # ------------------------------------------------------------------ #
    # 1. Fetch commit + root object                                        #
    # ------------------------------------------------------------------ #
    logger.info("Fetching commit %s / %s", stream_id, commit_id)
    root, commit_meta = fetch_commit(stream_id, commit_id, token=token, server_url=resolved_server_url)

    branch_name = commit_meta.get("branch_name", "")
    author      = commit_meta.get("author", "")
    message     = commit_meta.get("message", "")
    source_app  = commit_meta.get("source_application", "")

    source = forced_source or detect_source(root, source_app)
    instance_defs = collect_instance_definitions(root)
    obj_map = build_object_map(root)
    instance_defs.update(obj_map)  # merge so string IDs in InstanceDefinitionProxy.objects can be resolved
    logger.info("Object map built: %d entries total in instance_defs after merge", len(instance_defs))

    # ------------------------------------------------------------------ #
    # 2. Flatten element tree                                              #
    # ------------------------------------------------------------------ #
    # flatten_elements returns (Base, category_hint) tuples.
    # category_hint is the nearest ancestor Collection name that matches a known
    # Revit category — passed through to classify_element instead of mutating
    # the SpecklePy object.
    element_tuples = flatten_elements(root)
    logger.info("Flattened %d elements (source=%s)", len(element_tuples), source)

    # Log unique collection hints to verify they are being picked up
    hints = {hint for _, hint in element_tuples if hint}
    if hints:
        logger.info("Category hints found in tree: %s", sorted(hints))

    # ------------------------------------------------------------------ #
    # 3. DB work                                                           #
    # ------------------------------------------------------------------ #
    conn = get_conn()
    try:
        model_id = upsert_model(
            conn,
            stream_id=stream_id,
            commit_id=commit_id,
            branch_name=branch_name,
            source=source,
            author=author,
            message=message,
            server_url=resolved_server_url,
        )

        element_count = 0
        skipped_count = 0
        geo_count = 0
        no_geo_by_type: dict[str, int] = {}
        _prop_debug_quota = 10  # log at most this many "no prop values found" lines

        for obj, category_hint in element_tuples:
            speckle_id = getattr(obj, "id", None)
            if not speckle_id:
                skipped_count += 1
                continue

            speckle_type = getattr(obj, "speckle_type", "") or ""

            try:
                classification = classify_element(speckle_type, obj, category_hint, source=source)
                ifc_class    = classification["ifc_class"]
                category     = classification["category"]
                storey       = get_storey(obj)
                app_id       = get_application_id(obj)
                elem_hash    = compute_element_hash(obj)
                name         = _get_name(obj)

                element_id = upsert_element(
                    conn,
                    model_id=model_id,
                    application_id=app_id,
                    speckle_id=speckle_id,
                    speckle_type=speckle_type,
                    ifc_class=ifc_class,
                    category=category,
                    name=name,
                    storey=storey,
                    elem_hash=elem_hash,
                )

                geo = extract_geometry(obj, instance_defs=instance_defs)

                # IFC files: mesh geometry is often absent or non-watertight, so
                # volume_m3 / area_m2 are null even when Qto_*BaseQuantities values exist.
                # Fall back to the IFC quantity sets to fill in the gap.
                if source == "IFC":
                    # Property scan first — deep-traverse the whole object tree.
                    # These values take priority over mesh-derived ones (IFC meshes are
                    # often non-watertight, making signed-volume and area unreliable).
                    # Mesh geometry is kept for bbox/centroid/viewer but volume/area
                    # are overwritten whenever the property scan finds an authoritative value.
                    prop_vol  = _prop_volume_m3(obj)
                    prop_area = _prop_area_m2(obj)
                    if prop_vol is not None or prop_area is not None:
                        logger.debug(
                            "IFC prop scan [%s]: vol=%.4f area=%.4f",
                            speckle_id[:8], prop_vol or 0, prop_area or 0,
                        )
                        if geo is None:
                            geo = {
                                "bbox_min": None, "bbox_max": None,
                                "centroid": None, "centroid_si": None,
                                "volume_m3": prop_vol, "area_m2": prop_area, "mesh": None,
                            }
                        else:
                            if prop_vol  is not None: geo["volume_m3"] = prop_vol
                            if prop_area is not None: geo["area_m2"]   = prop_area
                    elif _prop_debug_quota > 0:
                        _prop_debug_quota -= 1
                        logger.debug(
                            "IFC prop scan [%s] NO VALUES — layout: %s",
                            speckle_id[:8], _debug_prop_layout(obj),
                        )

                if geo:
                    upsert_geometry(conn, element_id, geo)
                    geo_count += 1
                else:
                    # Track which types are missing geometry
                    short = speckle_type.split(".")[-1] or speckle_type
                    no_geo_by_type[short] = no_geo_by_type.get(short, 0) + 1

                extract_and_upsert_parameters(conn, element_id, obj)

                element_count += 1

            except Exception as exc:
                logger.warning("Skipping element %s: %s", speckle_id, exc)
                skipped_count += 1
                continue

        conn.commit()
        duration = round(time.monotonic() - t0, 2)
        logger.info(
            "Ingested %d elements (%d with geometry, %d skipped) in %.1fs — model_id=%s",
            element_count, geo_count, skipped_count, duration, model_id,
        )
        if no_geo_by_type:
            for t, cnt in sorted(no_geo_by_type.items(), key=lambda x: -x[1]):
                logger.info("  no geometry: %s × %d", t, cnt)
        return {
            "model_id":      model_id,
            "element_count": element_count,
            "skipped_count": skipped_count,
            "duration_s":    duration,
        }

    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


_VOL_KEYS  = frozenset({
    # English / IFC standard
    "NetVolume", "GrossVolume", "VOLUME", "Volume",
    # German / Spanish / Portuguese
    "Volumen",
})
_AREA_KEYS = frozenset({
    # English / IFC standard
    "NetSideArea", "NetArea", "NetFootprintArea",
    "GrossSideArea", "GrossArea", "GrossFootprintArea",
    "OuterSurfaceArea", "GrossSurfaceArea", "AREA", "Area",
    # German (Revit German locale)
    "Fläche", "Grundfläche", "Mantelfläche",
    # French / Spanish
    "Superficie", "Surface",
})
_DEEP_SKIP = frozenset({
    "displayValue", "@displayValue", "elements", "vertices", "@vertices",
    "faces", "@faces", "renderMesh", "definition", "objects",
    "id", "speckle_type", "applicationId", "totalChildrenCount",
})
# All top-level Speckle attribute names that may carry property/quantity data
_PROP_ATTRS = (
    "qtos", "psets", "properties", "parameters", "typeParameters",
    "udas", "archicadParameters",
)


def _read_numeric(raw) -> float | None:
    """Extract a positive float from a plain value or Speckle parameter wrapper."""
    if raw is None:
        return None
    if isinstance(raw, dict) and "value" in raw:
        raw = raw["value"]
    elif hasattr(raw, "value") and not isinstance(raw, (int, float)):
        raw = getattr(raw, "value")
    try:
        v = float(raw)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _deep_find_in_dict(d: dict, target_keys: frozenset, _depth: int = 0) -> float | None:
    """
    Recursively walk a plain dict tree looking for target_keys.
    Values that are SpecklePy Base objects are converted to dicts via __dict__.
    Geometry/element keys are skipped to avoid false positives.
    """
    if _depth > 8 or not d:
        return None

    # Check keys at this level first
    for key in target_keys:
        if key in d:
            v = _read_numeric(d[key])
            if v is not None:
                return v

    # Recurse into nested containers
    for k, v in d.items():
        if k in _DEEP_SKIP:
            continue
        if isinstance(v, dict):
            result = _deep_find_in_dict(v, target_keys, _depth + 1)
            if result is not None:
                return result
        elif hasattr(v, "__dict__") and not isinstance(v, (str, int, float, bool, type(None), list)):
            # SpecklePy Base nested inside a dict value — convert and recurse
            inner = {ik: iv for ik, iv in v.__dict__.items() if not ik.startswith("_")}
            if inner:
                result = _deep_find_in_dict(inner, target_keys, _depth + 1)
                if result is not None:
                    return result

    return None


def _vol_factor(units: str, raw: float) -> float:
    """
    Return the multiplier that converts a raw volume value to m³.

    When units are explicitly known, use the declared unit.
    When units are missing/unknown, use a magnitude heuristic:
      - raw > 1e6 → almost certainly mm³ (1e6 mm³ = 1 litre, tiny for structure)
      - raw ≤ 1e6 → almost certainly already in m³
    This handles standard IFC Qto_ sets (m³) vs Tekla/Revit connector values (mm³)
    without needing reliable unit metadata on every Speckle object.
    """
    u = (units or "").lower().strip()
    if u == "mm":   return 1e-9
    if u == "cm":   return 1e-6
    if u in ("m",): return 1.0
    if u == "ft":   return 0.028317
    if u == "in":   return 1.6387e-5
    return 1e-9 if raw > 1e6 else 1.0


def _area_factor(units: str, raw: float) -> float:
    """
    Return the multiplier that converts a raw area value to m².
    Same heuristic as _vol_factor: raw > 1e6 → mm², else → m².
    """
    u = (units or "").lower().strip()
    if u == "mm":   return 1e-6
    if u == "cm":   return 1e-4
    if u in ("m",): return 1.0
    if u == "ft":   return 0.092903
    if u == "in":   return 6.4516e-4
    return 1e-6 if raw > 1e6 else 1.0


def _prop_volume_m3(obj) -> float | None:
    """
    Scan all known property containers on a Speckle object for a volume quantity.
    Uses getattr (not __dict__) so SpecklePy's __getattr__ is respected regardless
    of internal storage implementation.
    """
    units = getattr(obj, "units", None) or ""
    for attr in _PROP_ATTRS:
        container = getattr(obj, attr, None)
        if not isinstance(container, dict):
            continue
        raw = _deep_find_in_dict(container, _VOL_KEYS)
        if raw is not None:
            return raw * _vol_factor(units, raw)
    return None


def _prop_area_m2(obj) -> float | None:
    """
    Scan all known property containers on a Speckle object for an area quantity.
    """
    units = getattr(obj, "units", None) or ""
    for attr in _PROP_ATTRS:
        container = getattr(obj, attr, None)
        if not isinstance(container, dict):
            continue
        raw = _deep_find_in_dict(container, _AREA_KEYS)
        if raw is not None:
            return raw * _area_factor(units, raw)
    return None


def _debug_prop_layout(obj) -> str:
    """
    Return a compact string showing which top-level property containers exist
    and what their first-level keys are.  Used when prop scan finds nothing.
    """
    parts = []
    parts.append(f"units={getattr(obj, 'units', 'MISSING')!r}")
    for attr in _PROP_ATTRS:
        val = getattr(obj, attr, None)
        if val is None:
            continue
        if isinstance(val, dict):
            # For nested dicts (e.g. properties → 'Property Sets' → ...) show 2 levels
            def _keys2(d, depth=0):
                if depth > 1 or not isinstance(d, dict):
                    return list(d.keys()) if isinstance(d, dict) else repr(d)[:40]
                return {k: _keys2(v, depth + 1) for k, v in d.items()}
            parts.append(f"{attr}={_keys2(val)}")
        else:
            parts.append(f"{attr}={type(val).__name__}")
    return " | ".join(parts)


def _get_name(obj) -> str:
    """Best-effort element name from common Speckle attributes."""
    for attr in ("name", "Name", "family", "type", "elementType"):
        val = getattr(obj, attr, None)
        if val and isinstance(val, str) and val.strip():
            return val.strip()
    # Tekla / v3 DataObject
    props = getattr(obj, "properties", None)
    if isinstance(props, dict):
        for key in ("Name", "name", "profile", "Profile"):
            val = props.get(key)
            if val and isinstance(val, str):
                return val.strip()
    return ""
