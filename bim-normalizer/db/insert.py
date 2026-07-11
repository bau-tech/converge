import json
import logging
import os
from typing import Any

from psycopg2.extras import execute_values

from ifc.classify import classify_material_category
from ifc.schema import sanitize_float, sanitize_floats

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Canonical parameter mapping — loaded once at import time from config file.
# Maps IFC-standard concept names (material, grade, fire_rating …) to the
# raw key names used by Revit, Tekla, and IFC connectors, plus (pset, key)
# pairs for IFC standard property sets.
# ---------------------------------------------------------------------------

_CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "config")

def _load_canonical_map():
    path = os.path.join(_CONFIG_DIR, "mapping_canonical.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        # Build reverse lookups
        key_to_canonical: dict[str, str] = {}       # lowercase key → canonical
        pset_key_to_canonical: dict[tuple, str] = {}  # (pset, key) → canonical
        for canonical, entry in data.items():
            if canonical.startswith("_"):
                continue
            for raw_key in entry.get("keys", []):
                key_to_canonical[raw_key.lower()] = canonical
            for ps_entry in entry.get("psets", []):
                pset = ps_entry.get("pset", "")
                key  = ps_entry.get("key", "")
                if pset and key:
                    pset_key_to_canonical[(pset, key)] = canonical
        return key_to_canonical, pset_key_to_canonical
    except Exception as exc:
        logger.warning("Could not load mapping_canonical.json: %s — canonical_key will be NULL", exc)
        return {}, {}

_KEY_TO_CANONICAL, _PSET_KEY_TO_CANONICAL = _load_canonical_map()


def _resolve_canonical(pset: str | None, key: str) -> str | None:
    """Return the canonical name for a (pset, key) pair, or None if not mapped."""
    if pset:
        canon = _PSET_KEY_TO_CANONICAL.get((pset, key))
        if canon:
            return canon
    return _KEY_TO_CANONICAL.get(key.lower())


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def upsert_model(conn, stream_id: str, commit_id: str, branch_name: str,
                 source: str, author: str, message: str,
                 server_url: str | None = None) -> str:
    """Insert or update a bim_model row. Returns model_id (UUID string)."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_models (stream_id, commit_id, branch_name, source, author, message, server_url)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (stream_id, commit_id) DO UPDATE SET
                branch_name  = EXCLUDED.branch_name,
                source       = EXCLUDED.source,
                author       = EXCLUDED.author,
                message      = EXCLUDED.message,
                server_url   = EXCLUDED.server_url,
                ingested_at  = NOW()
            RETURNING model_id
        """, (stream_id, commit_id, branch_name, source, author, message, server_url))
        return str(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------

def upsert_element(conn, model_id: str, application_id: str | None,
                   speckle_id: str, speckle_type: str, ifc_class: str,
                   category: str, name: str, storey: str | None,
                   elem_hash: str) -> str:
    """Insert or update a bim_element row. Returns element_id (UUID string)."""
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_elements
                (model_id, application_id, speckle_id, speckle_type,
                 ifc_class, category, name, storey, hash)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (model_id, speckle_id) DO UPDATE SET
                application_id = EXCLUDED.application_id,
                speckle_type   = EXCLUDED.speckle_type,
                ifc_class      = EXCLUDED.ifc_class,
                category       = EXCLUDED.category,
                name           = EXCLUDED.name,
                storey         = EXCLUDED.storey,
                hash           = EXCLUDED.hash
            RETURNING element_id
        """, (model_id, application_id, speckle_id, speckle_type,
              ifc_class, category, name, storey, elem_hash))
        return str(cur.fetchone()[0])


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def upsert_geometry(conn, element_id: str, geo: dict) -> None:
    """Insert or replace geometry row for an element."""
    mesh_json = json.dumps(geo.get("mesh")) if geo.get("mesh") else None
    # Defense-in-depth: extract_geometry() already sanitizes NaN/Inf, but guard
    # here too in case a future caller bypasses it — NaN/Inf would otherwise
    # land in a Postgres FLOAT column or break downstream range queries silently.
    bbox_min    = sanitize_floats(geo.get("bbox_min"))
    bbox_max    = sanitize_floats(geo.get("bbox_max"))
    centroid    = sanitize_floats(geo.get("centroid"))
    centroid_si = sanitize_floats(geo.get("centroid_si"))
    volume_m3   = sanitize_float(geo.get("volume_m3"))
    area_m2     = sanitize_float(geo.get("area_m2"))
    if (bbox_min != geo.get("bbox_min") or bbox_max != geo.get("bbox_max")
            or centroid != geo.get("centroid") or centroid_si != geo.get("centroid_si")
            or volume_m3 != geo.get("volume_m3") or area_m2 != geo.get("area_m2")):
        logger.warning("upsert_geometry: non-finite value(s) sanitized to None for element %s", element_id)
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_geometry
                (element_id, bbox_min, bbox_max, centroid, centroid_si, volume_m3, area_m2, mesh)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT (element_id) DO UPDATE SET
                bbox_min    = EXCLUDED.bbox_min,
                bbox_max    = EXCLUDED.bbox_max,
                centroid    = EXCLUDED.centroid,
                centroid_si = EXCLUDED.centroid_si,
                volume_m3   = EXCLUDED.volume_m3,
                area_m2     = EXCLUDED.area_m2,
                mesh        = EXCLUDED.mesh
        """, (
            element_id,
            bbox_min,
            bbox_max,
            centroid,
            centroid_si,
            volume_m3,
            area_m2,
            mesh_json,
        ))


# ---------------------------------------------------------------------------
# Semantic search embeddings
# ---------------------------------------------------------------------------

def get_element_ids_missing_embedding(conn, model_id: str) -> list[str]:
    """Element ids for this model with no bim_element_embeddings row yet."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT e.element_id::text
            FROM bim_elements e
            LEFT JOIN bim_element_embeddings emb ON emb.element_id = e.element_id
            WHERE e.model_id = %s AND emb.element_id IS NULL
        """, (model_id,))
        return [r[0] for r in cur.fetchall()]


def upsert_element_embedding(conn, element_id: str, embed_text: str, vector: list[float]) -> None:
    vector = sanitize_floats(vector)
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO bim_element_embeddings (element_id, embed_text, embedding)
            VALUES (%s, %s, %s)
            ON CONFLICT (element_id) DO UPDATE SET
                embed_text = EXCLUDED.embed_text,
                embedding  = EXCLUDED.embedding
        """, (element_id, embed_text, vector))


# ---------------------------------------------------------------------------
# Parameters — flatten + upsert
# ---------------------------------------------------------------------------

def _speckle_obj_to_dict(obj: Any) -> dict | None:
    """
    Convert a SpecklePy Base object to a plain dict, filtering internal keys.
    Returns the object unchanged if it is already a dict, or None otherwise.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "__dict__"):
        return {
            k: v for k, v in obj.__dict__.items()
            if not k.startswith("_") and k not in ("id", "speckle_type", "applicationId")
        }
    return None


def _flatten_params(raw: Any, pset: str | None = None, default_unit: str | None = None) -> list[dict]:
    """
    Recursively flatten a parameters/properties/psets structure into
    [{pset, key, value, datatype, value_numeric, canonical_key, value_si, unit_si}] rows.

    Handles:
      - Revit parameters dict: {"Fire Rating": {"name":"Fire Rating","value":"EI90","type":"Text"}}
      - Tekla properties dict: {"MATERIAL": "S355", "GRADE": "S355"}
      - IFC property sets dict: {"Pset_WallCommon": {"FireRating": "EI90"}}
      - Plain key→value dicts
      - SpecklePy Base objects at any level (converted to dict transparently)

    `default_unit` is the model/object-level length unit (e.g. obj.units —
    "mm", "m", "ft") used for plain numeric values that don't carry their own
    "units" field. Revit parameter objects override this with their own
    per-parameter v["units"] when present.
    """
    rows = []
    if raw is None:
        return rows

    # SpecklePy Base objects arrive when IFC connectors serialise psets/qtos as
    # Speckle dynamic objects rather than plain JSON dicts — normalise them first.
    if not isinstance(raw, dict):
        raw = _speckle_obj_to_dict(raw)
        if not isinstance(raw, dict):
            return rows

    for k, v in raw.items():
        if k.startswith("_") or k in ("id", "speckle_type", "applicationId"):
            continue

        # SpecklePy Base → plain dict so the isinstance checks below work
        if not isinstance(v, (dict, str, int, float, bool, type(None))):
            v = _speckle_obj_to_dict(v) or v

        if isinstance(v, dict):
            # Revit parameter object: {"name": "...", "value": ..., "type": ...}
            if "name" in v and "value" in v and isinstance(v["name"], str):
                key      = v["name"]
                raw_val  = v["value"]
                canonical = _resolve_canonical(pset, key)
                value_numeric = _numeric_val(raw_val)
                unit = v.get("units") or default_unit
                value_si, unit_si = _normalize_numeric(canonical, value_numeric, unit)
                rows.append({
                    "pset":          pset,
                    "key":           key,
                    "value":         _str_val(raw_val),
                    "datatype":      str(v.get("type", "string")),
                    "value_numeric": value_numeric,
                    "canonical_key": canonical,
                    "value_si":      value_si,
                    "unit_si":       unit_si,
                })
            else:
                # Nested dict → recurse with k as new pset name (IFC property sets)
                rows.extend(_flatten_params(v, pset=k, default_unit=default_unit))
        elif isinstance(v, (str, int, float, bool)):
            key = str(k)
            canonical = _resolve_canonical(pset, key)
            value_numeric = _numeric_val(v)
            value_si, unit_si = _normalize_numeric(canonical, value_numeric, default_unit)
            rows.append({
                "pset":          pset,
                "key":           key,
                "value":         str(v),
                "datatype":      type(v).__name__,
                "value_numeric": value_numeric,
                "canonical_key": canonical,
                "value_si":      value_si,
                "unit_si":       unit_si,
            })
        elif isinstance(v, (list, tuple)):
            # Array-valued parameter (e.g. Revit's INSTANCE_FREE_HOST list of
            # element ids) — previously dropped silently. JSON-encode it instead
            # of losing it; list items may themselves be SpecklePy Base objects.
            key = str(k)
            canonical = _resolve_canonical(pset, key)
            try:
                json_val = json.dumps([_speckle_obj_to_dict(item) or item for item in v], default=str)
            except Exception:
                json_val = json.dumps([str(item) for item in v])
            rows.append({
                "pset":          pset,
                "key":           key,
                "value":         json_val,
                "datatype":      "json",
                "value_numeric": None,
                "canonical_key": canonical,
                "value_si":      None,
                "unit_si":       None,
            })
        else:
            logger.warning(
                "Unhandled parameter value type %s for key=%r pset=%r — dropping",
                type(v).__name__, k, pset,
            )
    return rows


def _str_val(v: Any) -> str | None:
    if v is None:
        return None
    return str(v)


def _numeric_val(v: Any) -> float | None:
    """Try to parse a BIM parameter value as a float."""
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    try:
        return float(str(v).replace(",", ".").strip())
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Unit normalization — convert length/area/volume/weight values to SI units
# (m / m2 / m3 / kg) so charts can compare quantities across sources that
# report in mm, ft, lb, etc. Stored additively in value_si/unit_si — the
# original 'value'/'value_numeric' columns are left untouched so existing
# numeric filters (main.py, chat/agent.py) keep working unchanged.
# ---------------------------------------------------------------------------

_LENGTH_TO_M = {
    "mm": 0.001, "millimeter": 0.001, "millimeters": 0.001, "millimetre": 0.001, "millimetres": 0.001,
    "cm": 0.01, "centimeter": 0.01, "centimeters": 0.01, "centimetre": 0.01, "centimetres": 0.01,
    "m": 1.0, "meter": 1.0, "meters": 1.0, "metre": 1.0, "metres": 1.0,
    "km": 1000.0, "kilometer": 1000.0, "kilometers": 1000.0,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
    "ft": 0.3048, "foot": 0.3048, "feet": 0.3048,
    "yd": 0.9144, "yard": 0.9144, "yards": 0.9144,
}

_MASS_TO_KG = {
    "kg": 1.0, "kilogram": 1.0, "kilograms": 1.0,
    "g": 0.001, "gram": 0.001, "grams": 0.001,
    "t": 1000.0, "tonne": 1000.0, "tonnes": 1000.0, "ton": 1000.0, "tons": 1000.0,
    "lb": 0.45359237, "lbs": 0.45359237, "pound": 0.45359237, "pounds": 0.45359237,
}

_LENGTH_CANONICALS = {"length"}
_AREA_CANONICALS   = {"area"}
_VOLUME_CANONICALS = {"volume"}
_MASS_CANONICALS   = {"weight"}  # 'unit_mass' (kg/m) excluded — compound unit, can't convert from a single length/mass unit


def _si_factor(canonical: str | None, unit: str | None) -> tuple[float | None, str | None]:
    """Return (multiplier, SI unit symbol) to convert `unit` to SI for `canonical`, or (None, None)."""
    if not canonical or not unit:
        return None, None
    u = unit.strip().lower()
    if canonical in _LENGTH_CANONICALS:
        f = _LENGTH_TO_M.get(u)
        return (f, "m") if f else (None, None)
    if canonical in _AREA_CANONICALS:
        f = _LENGTH_TO_M.get(u)
        return (f * f, "m2") if f else (None, None)
    if canonical in _VOLUME_CANONICALS:
        f = _LENGTH_TO_M.get(u)
        return (f ** 3, "m3") if f else (None, None)
    if canonical in _MASS_CANONICALS:
        f = _MASS_TO_KG.get(u)
        return (f, "kg") if f else (None, None)
    return None, None


def _normalize_numeric(canonical: str | None, value_numeric: float | None,
                        unit: str | None) -> tuple[float | None, str | None]:
    """Return (value_si, unit_si) for a parameter, or (None, None) if not convertible."""
    if value_numeric is None:
        return None, None
    factor, unit_si = _si_factor(canonical, unit)
    if factor is None:
        return None, None
    return value_numeric * factor, unit_si


def _flatten_top_level_attrs(obj: Any) -> list[dict]:
    """
    Capture material/grade/profile info exposed as direct attributes on the
    Speckle object itself (Tekla v3 DataObjects expose `material`, `grade`,
    and `profile` this way) rather than nested in parameters/properties/udas
    — these would otherwise never get a canonical_key and be invisible to
    canonical-based queries.
    """
    rows: list[dict] = []

    for attr, key in (("material", "material"), ("grade", "grade")):
        val = getattr(obj, attr, None)
        if isinstance(val, str) and val.strip():
            rows.append({
                "pset": None, "key": key, "value": val.strip(),
                "datatype": "string", "value_numeric": None,
                "canonical_key": _resolve_canonical(None, key),
            })

    profile = getattr(obj, "profile", None)
    profile_name: str | None = None
    if isinstance(profile, str):
        profile_name = profile
    elif profile is not None:
        profile_name = getattr(profile, "name", None)
        if profile_name is None and isinstance(profile, dict):
            profile_name = profile.get("name")
    if isinstance(profile_name, str) and profile_name.strip():
        rows.append({
            "pset": None, "key": "profile", "value": profile_name.strip(),
            "datatype": "string", "value_numeric": None,
            "canonical_key": _resolve_canonical(None, "profile"),
        })

    # IFC GlobalId — exposed as obj.globalId (IFC connector) or obj.GlobalId
    for attr in ("globalId", "GlobalId", "ifcGuid", "IfcGUID"):
        val = getattr(obj, attr, None)
        if isinstance(val, str) and val.strip():
            rows.append({
                "pset": None, "key": "globalId", "value": val.strip(),
                "datatype": "string", "value_numeric": None,
                "canonical_key": _resolve_canonical(None, "globalId"),
            })
            break

    return rows


def upsert_parameters(conn, element_id: str, params_raw: list[dict]) -> None:
    """Delete existing parameters for element_id then bulk-insert fresh rows."""
    if not params_raw:
        return
    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_parameters WHERE element_id = %s", (element_id,))
        execute_values(cur, """
            INSERT INTO bim_parameters (element_id, pset, key, value, datatype, value_numeric, canonical_key, value_si, unit_si)
            VALUES %s
        """, [
            (
                element_id,
                r.get("pset"),
                r["key"],
                r.get("value"),
                r.get("datatype"),
                r.get("value_numeric"),
                r.get("canonical_key"),
                r.get("value_si"),
                r.get("unit_si"),
            )
            for r in params_raw if r.get("key")
        ])


def extract_and_upsert_parameters(conn, element_id: str, obj) -> None:
    """
    Extract all parameters/properties from a Speckle Base object and upsert
    into bim_parameters with canonical_key populated.

    Sources covered:
      Revit   — obj.parameters (instance), obj.typeParameters (type-level: Fire Rating, etc.)
      Tekla   — obj.properties (DataObject), obj.udas (user-defined attributes),
                top-level obj.material/grade/profile attributes
      IFC     — obj.psets (IFC property sets: Pset_WallCommon etc.)
      ArchiCAD — obj.archicadParameters
      Generic — obj.parameters, obj.properties fallback

    Also derives a 'material_category' canonical row (steel/concrete/timber/
    aluminum/masonry/glass/other) from whichever material/grade value was
    found, so charts can filter by material category without re-deriving it.
    """
    all_rows: list[dict] = []

    # Object-level length unit (e.g. "mm", "m", "ft") — used as the default
    # unit for plain numeric values that don't carry their own "units" field
    # (Tekla/IFC properties, psets, qtos). Revit parameter objects carry their
    # own per-parameter "units" and override this.
    default_unit = getattr(obj, "units", None)
    if not isinstance(default_unit, str):
        default_unit = None

    # ── Top-level material/grade/profile attributes (Tekla DataObjects) ────
    all_rows.extend(_flatten_top_level_attrs(obj))

    # ── Revit instance parameters ──────────────────────────────────────────
    params = getattr(obj, "parameters", None)
    if params is not None:
        raw = params.__dict__ if hasattr(params, "__dict__") else params
        all_rows.extend(_flatten_params(raw, pset="parameters", default_unit=default_unit))

    # ── Revit type-level parameters (Fire Rating, Assembly Code, etc.) ─────
    # CRITICAL: type params contain fire rating, structural material, OmniClass,
    # assembly code — most BIM quality checks depend on these.
    type_params = getattr(obj, "typeParameters", None)
    if type_params is not None:
        raw = type_params.__dict__ if hasattr(type_params, "__dict__") else type_params
        all_rows.extend(_flatten_params(raw, pset="typeParameters", default_unit=default_unit))

    # ── Tekla / v3 DataObject properties ──────────────────────────────────
    properties = getattr(obj, "properties", None)
    if isinstance(properties, dict):
        all_rows.extend(_flatten_params(properties, pset="properties", default_unit=default_unit))

    # ── Tekla user-defined attributes (UDA) ───────────────────────────────
    udas = getattr(obj, "udas", None)
    if isinstance(udas, dict):
        all_rows.extend(_flatten_params(udas, pset="udas", default_unit=default_unit))

    # ── IFC standard property sets (Pset_WallCommon, Qto_*, etc.) ─────────
    # psets may be a plain dict OR a SpecklePy Base object (IFC connector sends
    # psets as dynamic Speckle objects, not plain JSON maps).
    psets = getattr(obj, "psets", None)
    if isinstance(psets, list):
        for pset_obj in psets:
            pset_name = getattr(pset_obj, "name", None) or "Pset"
            raw = pset_obj.__dict__ if hasattr(pset_obj, "__dict__") else pset_obj
            all_rows.extend(_flatten_params(raw, pset=pset_name, default_unit=default_unit))
    else:
        psets_dict = _speckle_obj_to_dict(psets)
        if psets_dict:
            for pset_name, pset_val in psets_dict.items():
                all_rows.extend(_flatten_params(pset_val, pset=pset_name, default_unit=default_unit))

    # ── ArchiCAD parameters ────────────────────────────────────────────────
    ac_params = getattr(obj, "archicadParameters", None)
    if isinstance(ac_params, dict):
        all_rows.extend(_flatten_params(ac_params, pset="archicadParameters", default_unit=default_unit))

    # ── IFC quantity sets (Qto_*BaseQuantities — volume, area, length) ────
    # qtos may also be a SpecklePy Base object rather than a plain dict.
    qtos = getattr(obj, "qtos", None)
    qtos_dict = _speckle_obj_to_dict(qtos)
    if qtos_dict:
        for qto_name, qto_val in qtos_dict.items():
            all_rows.extend(_flatten_params(qto_val, pset=qto_name, default_unit=default_unit))

    # ── Derived: element weight from UnitMass × Length (IFC steel) ───────
    # IFC's Pset_SteelStructuralElementCommon.UnitMass is in kg/m (per IFC
    # standard) but cannot be auto-converted to kg because it is a compound
    # unit (kg/m). When no explicit weight parameter is present, derive it.
    if not any(r.get("canonical_key") == "weight" for r in all_rows):
        um_row  = next((r for r in all_rows if r.get("canonical_key") == "unit_mass"
                        and r.get("value_numeric") is not None), None)
        len_row = next((r for r in all_rows if r.get("canonical_key") == "length"
                        and r.get("value_si") is not None), None)
        if um_row and len_row:
            weight_kg = um_row["value_numeric"] * len_row["value_si"]
            all_rows.append({
                "pset": None, "key": "Computed Weight",
                "value": str(round(weight_kg, 3)),
                "datatype": "float",
                "value_numeric": weight_kg,
                "canonical_key": "weight",
                "value_si": weight_kg,
                "unit_si": "kg",
            })

    # ── Derived: material_category (steel/concrete/timber/...) ────────────
    material_val = next((r["value"] for r in all_rows if r.get("canonical_key") == "material" and r.get("value")), None)
    grade_val    = next((r["value"] for r in all_rows if r.get("canonical_key") == "grade" and r.get("value")), None)
    category = classify_material_category(material_val) or classify_material_category(grade_val)
    if category:
        all_rows.append({
            "pset": None, "key": "Material Category", "value": category,
            "datatype": "string", "value_numeric": None,
            "canonical_key": "material_category",
        })

    # Collision check: same canonical_key resolved from more than one pset with
    # different values. Precedence is implicit in insertion order above
    # (parameters > typeParameters > properties > udas > psets > archicadParameters
    # > qtos > derived) — no row is dropped, this only makes silent collisions
    # discoverable for a consumer that naively queries by canonical_key alone.
    by_canonical: dict[str, list[dict]] = {}
    for r in all_rows:
        ck = r.get("canonical_key")
        if ck:
            by_canonical.setdefault(ck, []).append(r)
    for ck, group in by_canonical.items():
        distinct = {(r.get("pset"), r.get("value")) for r in group}
        if len({v for _, v in distinct}) > 1:
            logger.warning(
                "Parameter collision for element %s: canonical_key=%r has conflicting values across psets: %s",
                element_id, ck, sorted(distinct, key=lambda x: (x[0] or "", x[1] or "")),
            )

    upsert_parameters(conn, element_id, all_rows)
