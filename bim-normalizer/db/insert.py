import json
import logging
import os
from typing import Any

from psycopg2.extras import execute_values
from specklepy.objects import Base

from ifc.classify import classify_material_category, extract_profile_from_name
from ifc.schema import LENGTH_TO_M, MASS_TO_KG, sanitize_float, sanitize_floats

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
        builtin_to_canonical: dict[str, str] = {}   # Revit BuiltInParameter enum name → canonical
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
            for builtin_name in entry.get("builtin_params", []):
                builtin_to_canonical[builtin_name] = canonical
        return key_to_canonical, pset_key_to_canonical, builtin_to_canonical
    except Exception as exc:
        logger.warning("Could not load mapping_canonical.json: %s — canonical_key will be NULL", exc)
        return {}, {}, {}

_KEY_TO_CANONICAL, _PSET_KEY_TO_CANONICAL, _BUILTIN_TO_CANONICAL = _load_canonical_map()


def _resolve_canonical(pset: str | None, key: str, internal_definition_name: str | None = None) -> str | None:
    """
    Return the canonical name for a parameter, or None if not mapped.

    internal_definition_name (Revit only — the connector's stable
    BuiltInParameter enum name or shared-parameter GUID, see
    ParameterDefinitionHandler.cs in the Revit connector) is checked first
    when present: unlike `key` — the parameter's display name — it never
    varies with the source Revit installation's UI language, so it's the
    reliable match for Revit-sourced data regardless of locale. `key`-based
    matching (mapping_canonical.json's "keys" lists) remains the only option
    for non-Revit sources (Tekla/IFC/ArchiCAD), whose raw identifiers are
    already locale-independent internal names, not translated display text.
    """
    if internal_definition_name:
        canon = _BUILTIN_TO_CANONICAL.get(internal_definition_name)
        if canon:
            return canon
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

def upsert_elements_batch(conn, model_id: str, rows: list[dict]) -> dict[str, str]:
    """Batch version of upsert_element — one round trip for the whole list
    instead of one per element (see the module-level batching note near
    upsert_geometries_batch/upsert_parameters_batch for why this matters).
    Each row dict needs: application_id, speckle_id, speckle_type, ifc_class,
    category, name, storey, elem_hash. Returns {speckle_id: element_id}."""
    if not rows:
        return {}
    with conn.cursor() as cur:
        result = execute_values(cur, """
            INSERT INTO bim_elements
                (model_id, application_id, speckle_id, speckle_type,
                 ifc_class, category, name, storey, hash)
            VALUES %s
            ON CONFLICT (model_id, speckle_id) DO UPDATE SET
                application_id = EXCLUDED.application_id,
                speckle_type   = EXCLUDED.speckle_type,
                ifc_class      = EXCLUDED.ifc_class,
                category       = EXCLUDED.category,
                name           = EXCLUDED.name,
                storey         = EXCLUDED.storey,
                hash           = EXCLUDED.hash
            RETURNING speckle_id, element_id
        """, [
            (model_id, r["application_id"], r["speckle_id"], r["speckle_type"],
             r["ifc_class"], r["category"], r["name"], r["storey"], r["elem_hash"])
            for r in rows
        ], page_size=len(rows), fetch=True)
    return {speckle_id: str(element_id) for speckle_id, element_id in result}


def upsert_geometry(conn, element_id: str, geo: dict) -> None:
    """Insert or replace geometry row for an element."""
    mesh_json      = json.dumps(geo.get("mesh")) if geo.get("mesh") else None
    axis_json      = json.dumps(geo.get("axis")) if geo.get("axis") else None
    footprint_json = json.dumps(geo.get("footprint")) if geo.get("footprint") else None
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
                (element_id, bbox_min, bbox_max, centroid, centroid_si, volume_m3, area_m2, mesh, axis, footprint)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
            ON CONFLICT (element_id) DO UPDATE SET
                bbox_min    = EXCLUDED.bbox_min,
                bbox_max    = EXCLUDED.bbox_max,
                centroid    = EXCLUDED.centroid,
                centroid_si = EXCLUDED.centroid_si,
                volume_m3   = EXCLUDED.volume_m3,
                area_m2     = EXCLUDED.area_m2,
                mesh        = EXCLUDED.mesh,
                axis        = EXCLUDED.axis,
                footprint   = EXCLUDED.footprint
        """, (
            element_id,
            bbox_min,
            bbox_max,
            centroid,
            centroid_si,
            volume_m3,
            area_m2,
            mesh_json,
            axis_json,
            footprint_json,
        ))


def upsert_geometries_batch(conn, rows: list[dict]) -> None:
    """Batch version of upsert_geometry. Each row dict needs element_id + geo
    (the same dict upsert_geometry takes) — one round trip for the whole
    list. See the batching note near upsert_elements_batch: ingest_commit()
    used to call upsert_element/upsert_geometry/upsert_parameters once per
    element, meaning a 50k-element model did on the order of
    150k-200k individual round trips to Postgres — dominating wall-clock
    time (CPU sat at 30-45% because most of it was spent waiting on the
    network, not computing) and, combined with holding all those rows
    uncommitted at once, is what caused the shared-lock-table exhaustion
    fixed alongside this. Batching cuts that to a couple of round trips per
    ~500-element chunk."""
    if not rows:
        return
    values = []
    for r in rows:
        geo = r["geo"]
        mesh_json      = json.dumps(geo.get("mesh")) if geo.get("mesh") else None
        axis_json      = json.dumps(geo.get("axis")) if geo.get("axis") else None
        footprint_json = json.dumps(geo.get("footprint")) if geo.get("footprint") else None
        bbox_min    = sanitize_floats(geo.get("bbox_min"))
        bbox_max    = sanitize_floats(geo.get("bbox_max"))
        centroid    = sanitize_floats(geo.get("centroid"))
        centroid_si = sanitize_floats(geo.get("centroid_si"))
        volume_m3   = sanitize_float(geo.get("volume_m3"))
        area_m2     = sanitize_float(geo.get("area_m2"))
        values.append((r["element_id"], bbox_min, bbox_max, centroid, centroid_si,
                        volume_m3, area_m2, mesh_json, axis_json, footprint_json))
    with conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO bim_geometry
                (element_id, bbox_min, bbox_max, centroid, centroid_si, volume_m3, area_m2, mesh, axis, footprint)
            VALUES %s
            ON CONFLICT (element_id) DO UPDATE SET
                bbox_min    = EXCLUDED.bbox_min,
                bbox_max    = EXCLUDED.bbox_max,
                centroid    = EXCLUDED.centroid,
                centroid_si = EXCLUDED.centroid_si,
                volume_m3   = EXCLUDED.volume_m3,
                area_m2     = EXCLUDED.area_m2,
                mesh        = EXCLUDED.mesh,
                axis        = EXCLUDED.axis,
                footprint   = EXCLUDED.footprint
        """, values, template="(%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb)", page_size=len(values))


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


def upsert_element_embeddings_batch(conn, rows: list[tuple[str, str, list[float]]]) -> None:
    """Batch version of upsert_element_embedding. `rows` is
    [(element_id, embed_text, vector), ...] — one round trip for the whole
    batch instead of one insert per element (this loop used to do exactly
    that inside _build_missing_embeddings, the same N+1 pattern the main
    ingest loop had before batching)."""
    if not rows:
        return
    values = [(eid, text, sanitize_floats(vector)) for eid, text, vector in rows]
    with conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO bim_element_embeddings (element_id, embed_text, embedding)
            VALUES %s
            ON CONFLICT (element_id) DO UPDATE SET
                embed_text = EXCLUDED.embed_text,
                embedding  = EXCLUDED.embedding
        """, values, page_size=len(values))


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
                # Revit only — see _resolve_canonical's docstring for why this
                # is checked ahead of the display-name-based (pset, key) match.
                internal_definition_name = v.get("internalDefinitionName")
                canonical = _resolve_canonical(pset, key, internal_definition_name)
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
        elif v is None:
            # An absent/inapplicable optional parameter (e.g. many of a
            # connector's "System Type Parameters" fields on any given
            # element) — not an anomaly, so no warning. This is the single
            # most common branch hit in this loop; logging it per-occurrence
            # was measurable per-element overhead across a whole model.
            continue
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

# Length/mass unit tables live in ifc.schema (single source of truth, also
# used by ifc/export.py's geometry math) — imported above as LENGTH_TO_M /
# MASS_TO_KG rather than duplicated here.

_LENGTH_CANONICALS = {"length"}
_AREA_CANONICALS   = {"area"}
_VOLUME_CANONICALS = {"volume"}
_MASS_CANONICALS   = {"weight"}  # 'unit_mass' (kg/m) excluded — compound unit, can't convert from a single length/mass unit

# Standard engineering constant for structural steel (ASTM A36/A992, S235/S355,
# etc. all fall within ~7700-7900 kg/m³) — used as a Volume-based weight
# fallback for sources (chiefly Revit) that expose Volume natively but no
# Weight/Mass/UnitMass parameter at all. See the derivation below.
_STEEL_DENSITY_KG_M3 = 7850.0


def _si_factor(canonical: str | None, unit: str | None) -> tuple[float | None, str | None]:
    """Return (multiplier, SI unit symbol) to convert `unit` to SI for `canonical`, or (None, None)."""
    if not canonical:
        return None, None
    if canonical in _MASS_CANONICALS:
        # Flat Tekla/UDA-style values (NET_WEIGHT etc.) carry no per-parameter
        # unit at all — _flatten_params falls back to the model's LENGTH unit
        # (obj.units, e.g. "mm") for every plain scalar regardless of what it
        # actually measures, which is meaningless for a mass value. Without
        # this, that bogus unit fails the _MASS_TO_KG lookup below and the
        # reading is silently dropped from value_si (and therefore from
        # total_steel_weight_kg's sum, which requires value_si IS NOT NULL)
        # even though the raw number is almost always already in kg by
        # convention. Treat any unit that isn't a recognized mass unit
        # (including none at all) as already being kg; a real explicit mass
        # unit (kg/g/t/lb) still converts normally below.
        if unit:
            f = MASS_TO_KG.get(unit.strip().lower())
            if f:
                return f, "kg"
        return 1.0, "kg"
    if not unit:
        return None, None
    u = unit.strip().lower()
    if canonical in _LENGTH_CANONICALS:
        f = LENGTH_TO_M.get(u)
        return (f, "m") if f else (None, None)
    if canonical in _AREA_CANONICALS:
        f = LENGTH_TO_M.get(u)
        return (f * f, "m2") if f else (None, None)
    if canonical in _VOLUME_CANONICALS:
        f = LENGTH_TO_M.get(u)
        return (f ** 3, "m3") if f else (None, None)
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


def upsert_parameters_batch(conn, rows: list[tuple[str, list[dict]]]) -> None:
    """Batch version of upsert_parameters. `rows` is [(element_id, params_raw), ...]
    — one DELETE (WHERE element_id = ANY(...)) and one execute_values INSERT
    for the whole chunk, instead of a DELETE+INSERT round trip per element."""
    element_ids = [eid for eid, _ in rows if eid]
    if not element_ids:
        return
    with conn.cursor() as cur:
        cur.execute("DELETE FROM bim_parameters WHERE element_id = ANY(%s::uuid[])", (element_ids,))
        flat = [
            (
                element_id, r.get("pset"), r["key"], r.get("value"), r.get("datatype"),
                r.get("value_numeric"), r.get("canonical_key"), r.get("value_si"), r.get("unit_si"),
            )
            for element_id, params_raw in rows
            for r in params_raw if r.get("key")
        ]
        if flat:
            execute_values(cur, """
                INSERT INTO bim_parameters (element_id, pset, key, value, datatype, value_numeric, canonical_key, value_si, unit_si)
                VALUES %s
            """, flat, page_size=len(flat))


def extract_parameters(obj, speckle_id: str | None = None) -> list[dict]:
    """
    Extract all parameters/properties from a Speckle Base object into the
    flat row-dict shape upsert_parameters/upsert_parameters_batch expect.
    Pure computation — no DB access — so callers can extract every element's
    parameters up front and upsert them all in one batch (see
    upsert_parameters_batch) rather than one DB round trip per element.

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

    # ── v3 Revit connector instance/definition split ───────────────────────
    # Same split that affects geometry (ifc/geometry.py's _get_all_meshes,
    # see fix_structural_geometry_v3 note): structural family instances
    # (beams, columns) carry their family-TYPE parameters on obj.definition,
    # not on the instance object itself. "Structural Material" is set at the
    # type level in Revit, so for these elements it lived only on
    # obj.definition.typeParameters — never read by the blocks above, which
    # is why steel/metal material silently went uncaptured for exactly the
    # elements (structural framing) that most need it.
    defn = getattr(obj, "definition", None)
    if isinstance(defn, Base):
        defn_params = getattr(defn, "parameters", None)
        if defn_params is not None:
            raw = defn_params.__dict__ if hasattr(defn_params, "__dict__") else defn_params
            all_rows.extend(_flatten_params(raw, pset="definition.parameters", default_unit=default_unit))
        defn_type_params = getattr(defn, "typeParameters", None)
        if defn_type_params is not None:
            raw = defn_type_params.__dict__ if hasattr(defn_type_params, "__dict__") else defn_type_params
            all_rows.extend(_flatten_params(raw, pset="definition.typeParameters", default_unit=default_unit))

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
    # IFC's MassPerLength (Pset_ProfileMechanical, per the real IFC standard —
    # see config/mapping_canonical.json's 'unit_mass' entry) is in kg/m but
    # cannot be auto-converted to kg because it is a compound unit (kg/m).
    # When no explicit weight parameter is present, derive it.
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

    # ── Derived: steel weight from Volume × density (Revit) ────────────────
    # Revit's native structural framing/column parameters include Volume but
    # no Weight/Mass/UnitMass at all (that's a Tekla/IFC-steel-detailing
    # convention, covered by the UnitMass × Length derivation above) — so
    # without this, total_steel_weight_kg (db/query.py's get_model_summary)
    # stays 0 for pure-Revit models even once material_category is correctly
    # classified as 'steel'. Only applies to elements already classified as
    # steel — density is material-specific, so this must not run for
    # concrete/timber/other volumes. Explicit source data (weight or
    # unit_mass+length, both handled above) always takes precedence.
    if category == "steel" and not any(r.get("canonical_key") == "weight" for r in all_rows):
        # A source can expose both a Net and a Gross volume under the same
        # canonical_key (see the collision-check comment below) — prefer a
        # Net-labeled row, consistent with db/query.py's Net preference for
        # every other volume/area aggregation, so this fallback doesn't
        # quietly overestimate weight using the larger Gross figure.
        vol_candidates = [r for r in all_rows if r.get("canonical_key") == "volume"
                          and r.get("value_si") is not None]
        vol_row = next((r for r in vol_candidates if "net" in (r.get("key") or "").lower()), None) \
            or (vol_candidates[0] if vol_candidates else None)
        if vol_row:
            weight_kg = vol_row["value_si"] * _STEEL_DENSITY_KG_M3
            all_rows.append({
                "pset": None, "key": "Computed Weight (Volume × steel density)",
                "value": str(round(weight_kg, 3)),
                "datatype": "float",
                "value_numeric": weight_kg,
                "canonical_key": "weight",
                "value_si": weight_kg,
                "unit_si": "kg",
            })

    # ── Derived: profile designation from the element's own name ──────────
    # Some Revit exports have no dedicated profile/section parameter at all
    # (confirmed against a real German export: fields present were
    # materialType/structuralAsset/Querschnittsform — a shape *category*
    # like "I-Profil Breitflansch", not the size designation — with "HEA 400"
    # only appearing in the element's own name, "Tragwerksstützen - HEA
    # 400"). Only fires when nothing above already resolved a profile (never
    # overrides a real Type Name/Section/Profile Name parameter) and the
    # element is already classified as steel — single-letter section
    # prefixes (C, L, T, U, W, S) can coincidentally match unrelated names
    # (e.g. a wall type code), and the "Steel Profiles" chart is scoped to
    # steel elements anyway, so this avoids a misleading "profile" value
    # showing up elsewhere (element detail, CSV export) for a non-steel
    # element that merely happens to contain a look-alike substring.
    if category == "steel" and not any(r.get("canonical_key") == "profile" for r in all_rows):
        obj_name = getattr(obj, "name", None)
        profile_from_name = extract_profile_from_name(obj_name) if isinstance(obj_name, str) else None
        if profile_from_name:
            all_rows.append({
                "pset": None, "key": "Profile (from name)", "value": profile_from_name,
                "datatype": "string", "value_numeric": None,
                "canonical_key": "profile",
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
                speckle_id, ck, sorted(distinct, key=lambda x: (x[0] or "", x[1] or "")),
            )

    return all_rows


# ---------------------------------------------------------------------------
# Element relationships — post-ingest pass
# ---------------------------------------------------------------------------
# bim_relationships existed in the schema from early on but nothing ever
# populated or queried it. Revit already exposes host/room/space references
# per hosted/MEP element (parentApplicationId, roomApplicationId,
# spaceApplicationId) — extract_parameters above was already capturing
# these as ordinary string-valued parameters, just never resolving
# them into actual element-to-element links. build_relationships() does that
# resolution as a separate pass, since the *referenced* element may not have
# an element_id yet at the point any single element is processed during the
# main per-object ingest loop — it must run after every element in the model
# has been upserted, not per-object during that loop.

# canonical_key -> relation_type stored in bim_relationships.
_REFERENCE_CANONICALS = {
    "parent_ref": "parent",
    "room_ref":   "room",
    "space_ref":  "space",
}
# Raw key names (lower-cased) to match when canonical_key wasn't populated —
# data ingested before parent_ref/room_ref/space_ref existed in
# mapping_canonical.json — mirroring the primary/fallback pattern the rest
# of the canonical system already uses (see db/query.py's _param_distribution).
_REFERENCE_RAW_KEYS = {
    "parentapplicationid": "parent",
    "hostapplicationid":   "parent",
    "host id":             "parent",
    "roomapplicationid":   "room",
    "spaceapplicationid":  "space",
}


def build_relationships(conn, model_id: str) -> int:
    """
    Resolve reference-type parameters (parent/room/space — a parameter value
    that's actually another element's application_id, not a scalar) into
    real bim_relationships rows.

    Idempotent: replaces this model's relationship rows on every call, so
    re-ingesting (or re-running this as a one-off backfill against
    already-ingested data) never accumulates stale or duplicate links.

    Returns the number of relationship rows written.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT application_id, element_id FROM bim_elements "
            "WHERE model_id = %s AND application_id IS NOT NULL AND application_id <> ''",
            (model_id,),
        )
        app_id_to_element = {row[0]: row[1] for row in cur.fetchall()}
        if not app_id_to_element:
            return 0

        cur.execute(
            """SELECT p.element_id, p.canonical_key, p.key, p.value
               FROM bim_parameters p
               JOIN bim_elements e ON e.element_id = p.element_id
               WHERE e.model_id = %s
                 AND p.value IS NOT NULL AND p.value <> ''
                 AND (p.canonical_key = ANY(%s) OR LOWER(p.key) = ANY(%s))""",
            (model_id, list(_REFERENCE_CANONICALS), list(_REFERENCE_RAW_KEYS)),
        )

        links: set[tuple] = set()
        for element_id, canonical_key, key, value in cur.fetchall():
            relation_type = _REFERENCE_CANONICALS.get(canonical_key) or _REFERENCE_RAW_KEYS.get((key or "").lower())
            if not relation_type:
                continue
            related_id = app_id_to_element.get(value)
            if related_id and related_id != element_id:
                links.add((element_id, related_id, relation_type))

        cur.execute(
            "DELETE FROM bim_relationships WHERE element_id IN "
            "(SELECT element_id FROM bim_elements WHERE model_id = %s)",
            (model_id,),
        )
        if links:
            execute_values(
                cur,
                "INSERT INTO bim_relationships (element_id, related_id, relation_type) VALUES %s "
                "ON CONFLICT (element_id, related_id, relation_type) DO NOTHING",
                list(links),
            )
        return len(links)


# relation_type values written here (aggregates/contained_in/connects/voids/fills)
# are distinct from build_relationships' own (parent/room/space) — see
# ifc/relationship_types.py's _IFC_CLASS_TO_RELATION_TYPE — so the two DELETEs
# below only ever remove rows the respective function itself wrote, never each
# other's.
_IFC_RELATION_TYPES = ("aggregates", "contained_in", "connects", "voids", "fills")


def insert_ifc_relationships(conn, model_id: str, links: list[tuple[str, str, str]]) -> int:
    """
    Write real IFC relationships (already extracted + GlobalId-resolved by
    routers/ifc_export.py's extract_ifc_relationships) into bim_relationships.

    Idempotent like build_relationships: replaces this model's rows of these
    specific relation_types on every call, so a re-run (re-ingest, or a
    one-off backfill) never accumulates stale or duplicate links.

    Also backfills bim_elements.storey for any element whose only reliable
    storey signal is a real "contained_in" (IfcRelContainedInSpatialStructure)
    relationship — confirmed necessary for IFC-sourced models specifically:
    ifc/spatial.py's get_storey() only ever reads flat per-element attributes
    (obj.level, parameters["Level"], Tekla PHASE, ...), and Speckle's IFC
    importer doesn't expose spatial containment on those attributes or via
    Base-object-tree nesting at all (confirmed against real ingested data —
    IfcBuildingStorey objects in the Speckle tree have no children of their
    own) — the *only* place that containment survives is the real IFC file's
    own relationship entities, which is exactly what `links` resolves. Never
    overwrites a storey value already set by classify.py's own per-source
    logic — this only fills the gap for elements it left NULL.

    Returns the number of relationship rows written.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM bim_relationships WHERE relation_type = ANY(%s) AND element_id IN "
            "(SELECT element_id FROM bim_elements WHERE model_id = %s)",
            (list(_IFC_RELATION_TYPES), model_id),
        )
        if links:
            execute_values(
                cur,
                "INSERT INTO bim_relationships (element_id, related_id, relation_type) VALUES %s "
                "ON CONFLICT (element_id, related_id, relation_type) DO NOTHING",
                links,
            )

        storey_ids = {storey_id for storey_id, _contained_id, rtype in links if rtype == "contained_in"}
        if storey_ids:
            cur.execute(
                "SELECT element_id::text, name FROM bim_elements WHERE element_id = ANY(%s::uuid[])",
                (list(storey_ids),),
            )
            storey_names = {r[0]: r[1] for r in cur.fetchall() if r[1]}
            storey_updates = [
                (contained_id, storey_names[storey_id])
                for storey_id, contained_id, rtype in links
                if rtype == "contained_in" and storey_id in storey_names
            ]
            if storey_updates:
                execute_values(
                    cur,
                    "UPDATE bim_elements AS e SET storey = v.storey_name "
                    "FROM (VALUES %s) AS v(element_id, storey_name) "
                    "WHERE e.element_id = v.element_id::uuid AND e.storey IS NULL",
                    storey_updates,
                )
        return len(links)
