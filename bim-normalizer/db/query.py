"""
Read-side queries for chart and table endpoints.
All functions take an open psycopg2 connection and return plain dicts/lists.
"""

import logging

from ifc.classify import classify_material_category, classify_section_family

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Parameter distribution helpers.
# Primary path: canonical_key (IFC-standard, source-agnostic).
# Fallback path: raw key list (for data ingested before canonical_key existed).
# ---------------------------------------------------------------------------

_MATERIAL_KEYS = [
    "Structural Material", "Material", "Type Material", "Material Name",
    "material", "BuildingMaterial",
    "MATERIAL", "MAIN_PART.MATERIAL",
]
_PROFILE_KEYS = [
    "Type Name", "Family", "Structural Framing Type", "Profile Name",
    "profile", "profileName",
    "PROFILE", "NAME", "MAIN_PART.NAME", "PROFILE_TYPE",
]
_GRADE_KEYS = [
    "Steel Grade", "Grade Short", "Grade", "grade", "grade_short",
    "Material Grade", "GRADE", "MAIN_PART.GRADE",
]

# ---------------------------------------------------------------------------
# Steel detection — used to scope the "Steel Profiles" chart to structural
# steel elements only, regardless of source application.
# ---------------------------------------------------------------------------


def _steel_element_ids(cur, model_id: str) -> set[str] | None:
    """
    Return the element_ids classified as structural steel.

    Primary path: canonical_key='material_category' = 'steel', derived at
    ingest time by classify_material_category() (works for Revit, Tekla, IFC,
    and Navisworks alike, since it operates on the already-normalised
    'material'/'grade' canonical values).

    Fallback: re-run classify_material_category() against raw 'material'/
    'grade' values for models ingested before material_category existed.

    Returns None if the model has no material/grade data at all, so callers
    can fall back to the unfiltered distribution instead of showing an empty
    chart for models that weren't ingested with material info.
    """
    cur.execute("""
        SELECT DISTINCT p.element_id::text
        FROM bim_parameters p
        JOIN bim_elements e ON e.element_id = p.element_id
        WHERE e.model_id = %s
          AND p.canonical_key = 'material_category'
          AND p.value = 'steel'
    """, (model_id,))
    rows = cur.fetchall()
    if rows:
        return {row[0] for row in rows}

    cur.execute("""
        SELECT DISTINCT p.element_id::text, p.value
        FROM bim_parameters p
        JOIN bim_elements e ON e.element_id = p.element_id
        WHERE e.model_id = %s
          AND p.canonical_key IN ('material', 'grade')
          AND p.value IS NOT NULL AND p.value <> ''
    """, (model_id,))
    rows = cur.fetchall()
    if not rows:
        return None
    return {eid for eid, val in rows if classify_material_category(val) == "steel"}


def _param_distribution_by_canonical(cur, model_id: str, canonical: str,
                                      element_ids: set[str] | list[str] | None = None) -> dict:
    """
    Return {value: count} using canonical_key — the IFC-standard concept name.
    Works for Revit, Tekla, and IFC files alike once data is re-ingested with
    canonical_key populated.

    If element_ids is given, only parameters belonging to those elements are
    counted (e.g. elements pre-filtered down to structural steel).
    """
    extra_where = ""
    params: list = [model_id, canonical]
    if element_ids is not None:
        extra_where = "AND p.element_id = ANY(%s::uuid[])"
        params.append(list(element_ids))

    cur.execute(f"""
        SELECT val, COUNT(*) AS cnt
        FROM (
            SELECT DISTINCT ON (p.element_id) p.value AS val
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE e.model_id = %s
              AND p.canonical_key = %s
              AND p.value IS NOT NULL
              AND p.value <> ''
              {extra_where}
            ORDER BY p.element_id, p.key
        ) ranked
        GROUP BY val
        ORDER BY cnt DESC
        LIMIT 100
    """, params)
    return {row[0]: row[1] for row in cur.fetchall()}


def _param_distribution(cur, model_id: str, keys: list[str],
                        canonical: str | None = None,
                        element_ids: set[str] | list[str] | None = None) -> dict:
    """
    Return {value: count}. Tries canonical_key first (IFC-standard), then falls
    back to raw key matching for data ingested before canonical_key was added.

    If element_ids is given, only those elements are considered (e.g. to scope
    a distribution to structural steel elements only).
    """
    if not keys and not canonical:
        return {}

    # Primary: canonical_key (fast index, app-agnostic)
    if canonical:
        result = _param_distribution_by_canonical(cur, model_id, canonical, element_ids=element_ids)
        if result:
            return result

    # Fallback: raw key list (legacy data / re-ingest not yet done)
    if not keys:
        return {}

    params: list = [model_id, keys]
    if element_ids is not None:
        extra_where = "AND p.element_id = ANY(%s::uuid[])"
        params.append(list(element_ids))
    else:
        extra_where = ""
    params.append(keys)

    cur.execute(f"""
        SELECT val, COUNT(*) AS cnt
        FROM (
            SELECT DISTINCT ON (p.element_id) p.value AS val
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE e.model_id = %s
              AND p.key = ANY(%s)
              AND p.value IS NOT NULL
              AND p.value <> ''
              {extra_where}
            ORDER BY p.element_id,
                     array_position(%s::text[], p.key)
        ) ranked
        GROUP BY val
        ORDER BY cnt DESC
        LIMIT 100
    """, params)
    return {row[0]: row[1] for row in cur.fetchall()}


_QTY_ALLOWED_FIELDS = {"category", "ifc_class", "storey"}


def _qty_by_field(cur, model_id: str, field: str) -> dict:
    """
    Return {value: {count, volume_m3, area_m2}} grouped by an bim_elements column.

    Volume and area fall back to bim_parameters (canonical qto values) when bim_geometry
    is null — this covers IFC files where mesh geometry is absent but Qto_*BaseQuantities
    are present and were stored as canonical_key='volume'/'area' during ingest.
    """
    if field not in _QTY_ALLOWED_FIELDS:
        raise ValueError(f"field must be one of {_QTY_ALLOWED_FIELDS!r}, got {field!r}")
    cur.execute(f"""
        WITH pv AS (
            SELECT p.element_id, MAX(p.value_si) AS value_si
            FROM bim_parameters p
            JOIN bim_elements   e ON e.element_id = p.element_id AND e.model_id = %s
            WHERE p.canonical_key = 'volume' AND p.unit_si = 'm3' AND p.value_si IS NOT NULL
            GROUP BY p.element_id
        ),
        pa AS (
            SELECT p.element_id, MAX(p.value_si) AS value_si
            FROM bim_parameters p
            JOIN bim_elements   e ON e.element_id = p.element_id AND e.model_id = %s
            WHERE p.canonical_key = 'area'   AND p.unit_si = 'm2' AND p.value_si IS NOT NULL
            GROUP BY p.element_id
        )
        SELECT
            COALESCE(e.{field}, 'Unknown')                    AS grp,
            COUNT(*)                                          AS cnt,
            COALESCE(SUM(COALESCE(g.volume_m3, pv.value_si)), 0) AS vol,
            COALESCE(SUM(COALESCE(g.area_m2,   pa.value_si)), 0) AS area
        FROM bim_elements e
        LEFT JOIN bim_geometry g  ON g.element_id  = e.element_id
        LEFT JOIN pv              ON pv.element_id = e.element_id
        LEFT JOIN pa              ON pa.element_id = e.element_id
        WHERE e.model_id = %s
        GROUP BY grp
        ORDER BY cnt DESC
    """, (model_id, model_id, model_id))
    return {
        row[0]: {"count": row[1], "volume_m3": round(row[2], 4), "area_m2": round(row[3], 4)}
        for row in cur.fetchall()
    }


def get_model_summary(conn, model_id: str) -> dict:
    """
    Return a chart-ready summary for one normalised model.

    Shape:
      model_id, source, author, branch_name, message, ingested_at,
      total_count, total_volume_m3, total_area_m2, geo_coverage,
      by_category, by_ifc_class, by_storey,
      by_material, by_profile, by_grade, by_section_class
    """
    with conn.cursor() as cur:
        # Model metadata (source app, author, etc.)
        cur.execute("""
            SELECT source, author, branch_name, message, ingested_at, stream_id, commit_id
            FROM bim_models WHERE model_id = %s
        """, (model_id,))
        meta_row = cur.fetchone()
        meta: dict = {}
        if meta_row:
            meta = {
                "source":      meta_row[0] or "",
                "author":      meta_row[1] or "",
                "branch_name": meta_row[2] or "",
                "message":     meta_row[3] or "",
                "ingested_at": meta_row[4].isoformat() if meta_row[4] else None,
                "stream_id":   meta_row[5] or "",
                "commit_id":   meta_row[6] or "",
            }

        # Totals — volume and area COALESCE bim_geometry (mesh) with bim_parameters
        # (IFC Qto canonical values) so IFC files without tessellated geometry still
        # report correct quantities from their Qto_*BaseQuantities property sets.
        cur.execute("""
            WITH pv AS (
                SELECT p.element_id, MAX(p.value_si) AS value_si
                FROM bim_parameters p
                JOIN bim_elements e ON e.element_id = p.element_id AND e.model_id = %s
                WHERE p.canonical_key = 'volume' AND p.unit_si = 'm3' AND p.value_si IS NOT NULL
                GROUP BY p.element_id
            ),
            pa AS (
                SELECT p.element_id, MAX(p.value_si) AS value_si
                FROM bim_parameters p
                JOIN bim_elements e ON e.element_id = p.element_id AND e.model_id = %s
                WHERE p.canonical_key = 'area' AND p.unit_si = 'm2' AND p.value_si IS NOT NULL
                GROUP BY p.element_id
            )
            SELECT
                COUNT(*)                                              AS total,
                COALESCE(SUM(COALESCE(g.volume_m3, pv.value_si)), 0) AS vol,
                COALESCE(SUM(COALESCE(g.area_m2,   pa.value_si)), 0) AS area,
                COUNT(g.element_id)                                   AS geo_count
            FROM bim_elements e
            LEFT JOIN bim_geometry g  ON g.element_id  = e.element_id
            LEFT JOIN pv              ON pv.element_id = e.element_id
            LEFT JOIN pa              ON pa.element_id = e.element_id
            WHERE e.model_id = %s
        """, (model_id, model_id, model_id))
        row = cur.fetchone()
        total, vol, area, geo_count = row
        geo_coverage = round(geo_count / total, 4) if total else 0

        by_category  = _qty_by_field(cur, model_id, "category")
        by_ifc_class = _qty_by_field(cur, model_id, "ifc_class")
        by_storey    = _qty_by_field(cur, model_id, "storey")

        # Concrete volume (m³) and steel weight (kg) — material-scoped aggregations.
        # Both rely on canonical_key='material_category' derived at ingest time.
        # Joined via LEFT JOIN so elements without material_category are excluded
        # rather than duplicated.
        cur.execute("""
            WITH pv AS (
                SELECT p.element_id, MAX(p.value_si) AS value_si
                FROM bim_parameters p
                JOIN bim_elements e ON e.element_id = p.element_id AND e.model_id = %s
                WHERE p.canonical_key = 'volume' AND p.unit_si = 'm3' AND p.value_si IS NOT NULL
                GROUP BY p.element_id
            )
            SELECT
                COALESCE(SUM(CASE WHEN mat.value = 'concrete'
                    THEN COALESCE(g.volume_m3, pv.value_si) END), 0),
                COALESCE(SUM(CASE WHEN mat.value = 'steel' AND w.value_si IS NOT NULL
                    THEN w.value_si END), 0)
            FROM bim_elements e
            LEFT JOIN bim_geometry   g   ON g.element_id   = e.element_id
            LEFT JOIN pv                 ON pv.element_id  = e.element_id
            LEFT JOIN bim_parameters mat ON mat.element_id = e.element_id
                AND mat.canonical_key = 'material_category'
            LEFT JOIN bim_parameters w   ON w.element_id   = e.element_id
                AND w.canonical_key = 'weight'
                AND w.value_si IS NOT NULL
            WHERE e.model_id = %s
        """, (model_id, model_id))
        _mat_row = cur.fetchone()
        concrete_volume_m3 = round(float(_mat_row[0] or 0), 3)
        steel_weight_kg    = round(float(_mat_row[1] or 0), 1)

        by_material  = _param_distribution(cur, model_id, _MATERIAL_KEYS,  canonical="material")
        by_grade     = _param_distribution(cur, model_id, _GRADE_KEYS,    canonical="grade")

        # "Steel Profiles" chart — scope profile names to steel elements only,
        # so concrete/timber/etc. type names don't pollute the chart.
        steel_ids  = _steel_element_ids(cur, model_id)
        by_profile = _param_distribution(cur, model_id, _PROFILE_KEYS, canonical="profile",
                                          element_ids=steel_ids)

        # "Section Classes" chart — group steel profiles by cross-section
        # family (HEA200 → "I / H Beams", RHS100x50x5 → "RHS/SHS", ...).
        by_section_class: dict[str, int] = {}
        for profile_name, cnt in by_profile.items():
            family = classify_section_family(profile_name) or "Other Sections"
            by_section_class[family] = by_section_class.get(family, 0) + cnt

    return {
        "model_id":        model_id,
        **meta,
        "total_count":     total,
        "total_volume_m3": round(float(vol), 4),
        "total_area_m2":   round(float(area), 4),
        "total_concrete_volume_m3": concrete_volume_m3,
        "total_steel_weight_kg":    steel_weight_kg,
        "geo_coverage":    geo_coverage,
        "by_category":     by_category,
        "by_ifc_class":    by_ifc_class,
        "by_storey":       by_storey,
        "by_material":     by_material,
        "by_profile":      by_profile,
        "by_grade":        by_grade,
        "by_section_class": by_section_class,
    }


# ---------------------------------------------------------------------------
# Flat element list — for the element table and viewer sync.
# Returns elements enriched with key parameter fields.
# ---------------------------------------------------------------------------

def get_elements_flat(conn, model_id: str, limit: int = 1000, offset: int = 0,
                      category: str | None = None,
                      ifc_class: str | None = None,
                      storey: str | None = None) -> dict:
    """
    Return {total, elements: [{id, speckle_id, category, ifc_class, name,
                                storey, volume_m3, area_m2, material, profile, grade,
                                material_category, profile_type}]}
    `id` mirrors speckle_id so the frontend viewer sync works without changes.
    """
    where = ["e.model_id = %s"]
    params: list = [model_id]
    if category:
        where.append("e.category ILIKE %s")
        params.append(f"%{category}%")
    if ifc_class:
        where.append("e.ifc_class = %s")
        params.append(ifc_class)
    if storey:
        where.append("e.storey ILIKE %s")
        params.append(f"%{storey}%")

    where_sql = " AND ".join(where)

    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT
                e.element_id, e.speckle_id, e.application_id,
                e.category, e.ifc_class, e.name, e.storey, e.speckle_type,
                g.volume_m3, g.area_m2, g.centroid,
                COUNT(*) OVER () AS total_count
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE {where_sql}
            ORDER BY e.storey NULLS LAST, e.category, e.name
            LIMIT %s OFFSET %s
        """, params + [limit, offset])
        rows = cur.fetchall()

        if rows:
            total = rows[0][11]
        else:
            # offset past last page — fetch the true count separately
            cur.execute(f"SELECT COUNT(*) FROM bim_elements e WHERE {where_sql}", params)
            total = cur.fetchone()[0]

        if not rows:
            return {"total": total, "elements": []}

        element_ids = [str(r[0]) for r in rows]

        # Bulk-fetch ALL non-null parameters for this page in one query.
        # Use canonical_key (preferred) or raw key fallback for material/profile/grade.
        classified_raw = {k: 'material' for k in _MATERIAL_KEYS}
        classified_raw.update({k: 'profile' for k in _PROFILE_KEYS})
        classified_raw.update({k: 'grade' for k in _GRADE_KEYS})

        cur.execute("""
            SELECT element_id::text, key, value, canonical_key
            FROM bim_parameters
            WHERE element_id = ANY(%s::uuid[])
              AND value IS NOT NULL AND value <> ''
            ORDER BY element_id, key
        """, (element_ids,))

        param_map: dict[str, dict] = {}   # eid -> {key: value}
        alias_map: dict[str, dict] = {}   # eid -> {alias: value}  (material/profile/grade)
        for eid, key, value, canon in cur.fetchall():
            if eid not in param_map:
                param_map[eid] = {}
                alias_map[eid] = {}
            param_map[eid][key] = value
            # Prefer canonical_key; fall back to raw key classification
            alias = canon if canon in ("material", "profile", "grade", "material_category") else classified_raw.get(key)
            if alias and alias not in alias_map[eid]:
                alias_map[eid][alias] = value

    elements = []
    for r in rows:
        eid = str(r[0])
        speckle_id = r[1]
        a = alias_map.get(eid, {})
        centroid = list(r[10]) if r[10] else None
        material_category = a.get("material_category")
        profile_type = (
            classify_section_family(a.get("profile"))
            if material_category == "steel" and a.get("profile") else None
        )
        elements.append({
            "id":           speckle_id,   # viewer sync key
            "speckle_id":   speckle_id,
            "element_id":   eid,
            "application_id": r[2],
            "category":     r[3] or "",
            "ifc_class":    r[4] or "",
            "name":         r[5] or "",
            "storey":       r[6] or "",
            "speckle_type": r[7] or "",
            "volume_m3":    round(float(r[8]), 6) if r[8] is not None else None,
            "area_m2":      round(float(r[9]), 4) if r[9] is not None else None,
            "centroid":     centroid,
            "material":     a.get("material"),
            "profile":      a.get("profile"),
            "grade":        a.get("grade"),
            "material_category": material_category,
            "profile_type": profile_type,
            # All raw BIM parameters — used by the pivot table for dynamic grouping
            "params":       param_map.get(eid, {}),
        })

    return {"total": total, "elements": elements}


# ---------------------------------------------------------------------------
# Parameter key discovery — used by the pivot table to build its field list.
# ---------------------------------------------------------------------------

def get_parameter_keys(conn, model_id: str) -> list[dict]:
    """
    Return all distinct parameter keys for a model, ordered by element coverage
    descending.  Each entry: {key, count, coverage_pct}.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM bim_elements WHERE model_id = %s", (model_id,)
        )
        total = cur.fetchone()[0] or 1

        cur.execute("""
            SELECT p.key, COUNT(DISTINCT p.element_id) AS cnt
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE e.model_id = %s
              AND p.value IS NOT NULL AND p.value <> ''
            GROUP BY p.key
            ORDER BY cnt DESC
            LIMIT 200
        """, (model_id,))
        return [
            {"key": row[0], "count": row[1], "coverage_pct": round(row[1] / total * 100, 1)}
            for row in cur.fetchall()
        ]


# ---------------------------------------------------------------------------
# BIM data-quality assessment
# ---------------------------------------------------------------------------

def get_model_qa(conn, model_id: str) -> dict:
    """
    Run data-quality checks on a normalised model and return a scored report.

    Checks:
      unclassified  — category is NULL / 'Generic Models' / 'Unknown'
      no_geometry   — no row in bim_geometry
      no_name       — name is NULL / empty / 'None'
      no_storey     — storey is NULL / empty
      no_material   — no material parameter found
      duplicate_ids — same application_id appears more than once
    """
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM bim_elements WHERE model_id = %s", (model_id,))
        total = int(cur.fetchone()[0] or 0)
        if total == 0:
            return {"total_elements": 0, "score": 1.0, "issues": {}}

        def _issue(count_sql, count_p, sample_sql, sample_p):
            cur.execute(count_sql, count_p)
            n = int(cur.fetchone()[0] or 0)
            samples: list = []
            if n:
                cur.execute(sample_sql, sample_p)
                samples = [r[0] for r in cur.fetchall() if r[0]]
            return n, samples

        no_class, no_class_s = _issue(
            "SELECT COUNT(*) FROM bim_elements WHERE model_id=%s"
            " AND (category IS NULL OR category ILIKE 'Generic Models' OR category ILIKE 'Unknown')",
            (model_id,),
            "SELECT speckle_id FROM bim_elements WHERE model_id=%s"
            " AND (category IS NULL OR category ILIKE 'Generic Models' OR category ILIKE 'Unknown') LIMIT 5",
            (model_id,),
        )
        no_geo, no_geo_s = _issue(
            "SELECT COUNT(*) FROM bim_elements e"
            " LEFT JOIN bim_geometry g ON g.element_id=e.element_id"
            " WHERE e.model_id=%s AND g.element_id IS NULL",
            (model_id,),
            "SELECT e.speckle_id FROM bim_elements e"
            " LEFT JOIN bim_geometry g ON g.element_id=e.element_id"
            " WHERE e.model_id=%s AND g.element_id IS NULL LIMIT 5",
            (model_id,),
        )
        no_name, no_name_s = _issue(
            "SELECT COUNT(*) FROM bim_elements WHERE model_id=%s"
            " AND (name IS NULL OR TRIM(name)='' OR name='None')",
            (model_id,),
            "SELECT speckle_id FROM bim_elements WHERE model_id=%s"
            " AND (name IS NULL OR TRIM(name)='' OR name='None') LIMIT 5",
            (model_id,),
        )
        no_storey, no_storey_s = _issue(
            "SELECT COUNT(*) FROM bim_elements WHERE model_id=%s"
            " AND (storey IS NULL OR TRIM(storey)='')",
            (model_id,),
            "SELECT speckle_id FROM bim_elements WHERE model_id=%s"
            " AND (storey IS NULL OR TRIM(storey)='') LIMIT 5",
            (model_id,),
        )
        no_mat, no_mat_s = _issue(
            "SELECT COUNT(*) FROM bim_elements e WHERE e.model_id=%s"
            " AND NOT EXISTS ("
            "   SELECT 1 FROM bim_parameters p"
            "   WHERE p.element_id=e.element_id"
            "   AND (p.canonical_key='material' OR p.key=ANY(%s))"
            "   AND p.value IS NOT NULL AND p.value<>'')",
            (model_id, _MATERIAL_KEYS),
            "SELECT e.speckle_id FROM bim_elements e WHERE e.model_id=%s"
            " AND NOT EXISTS ("
            "   SELECT 1 FROM bim_parameters p"
            "   WHERE p.element_id=e.element_id"
            "   AND (p.canonical_key='material' OR p.key=ANY(%s))"
            "   AND p.value IS NOT NULL AND p.value<>'') LIMIT 5",
            (model_id, _MATERIAL_KEYS),
        )
        cur.execute(
            "SELECT COUNT(*) FROM ("
            "  SELECT application_id FROM bim_elements"
            "  WHERE model_id=%s AND application_id IS NOT NULL AND application_id<>''"
            "  GROUP BY application_id HAVING COUNT(*)>1) d",
            (model_id,),
        )
        dup_count = int(cur.fetchone()[0] or 0)

    def _r(n):
        return n / total

    score = max(0.0, 1.0 - (
        0.20 * _r(no_class) +
        0.25 * _r(no_geo) +
        0.15 * _r(no_name) +
        0.15 * _r(no_storey) +
        0.10 * _r(no_mat) +
        0.15 * min(1.0, dup_count / max(1, total * 0.05))
    ))

    return {
        "total_elements": total,
        "score": round(score, 3),
        "issues": {
            "unclassified":  {"count": no_class,  "samples": no_class_s},
            "no_geometry":   {"count": no_geo,    "samples": no_geo_s},
            "no_name":       {"count": no_name,   "samples": no_name_s},
            "no_storey":     {"count": no_storey, "samples": no_storey_s},
            "no_material":   {"count": no_mat,    "samples": no_mat_s},
            "duplicate_ids": {"count": dup_count, "samples": []},
        },
    }


# ---------------------------------------------------------------------------
# 5D Quantity takeoff — grouped aggregation for BoQ / cost estimation
# ---------------------------------------------------------------------------

def get_quantity_takeoff(conn, model_id: str, group_by: str = "ifc_class") -> dict:
    """
    Return structured quantity takeoff grouped by ifc_class, category, or storey.
    Reads volume_m3 and area_m2 from bim_geometry.
    """
    allowed = {"ifc_class", "category", "storey"}
    field = group_by if group_by in allowed else "ifc_class"

    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT
                COALESCE(e.{field}, 'Unknown') AS grp,
                COUNT(*)                        AS element_count,
                COALESCE(SUM(g.volume_m3), 0)  AS volume_m3,
                COALESCE(SUM(g.area_m2), 0)    AS area_m2,
                COUNT(g.element_id)             AS elements_with_geometry
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s
            GROUP BY grp
            ORDER BY SUM(g.volume_m3) DESC NULLS LAST, COUNT(*) DESC
        """, (model_id,))
        rows = cur.fetchall()

        cur.execute("""
            SELECT COUNT(*), COALESCE(SUM(g.volume_m3), 0), COALESCE(SUM(g.area_m2), 0)
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s
        """, (model_id,))
        total_row = cur.fetchone()

    return {
        "model_id":        model_id,
        "group_by":        field,
        "total_elements":  int(total_row[0]),
        "total_volume_m3": round(float(total_row[1]), 4),
        "total_area_m2":   round(float(total_row[2]), 4),
        "rows": [
            {
                "group":                  row[0],
                "element_count":          int(row[1]),
                "volume_m3":              round(float(row[2]), 4),
                "area_m2":                round(float(row[3]), 4),
                "elements_with_geometry": int(row[4]),
            }
            for row in rows
        ],
    }


# ---------------------------------------------------------------------------
# QA element drill-down — returns actual element rows for a specific issue
# ---------------------------------------------------------------------------

def get_qa_elements(conn, model_id: str, issue: str, limit: int = 50) -> list:
    """
    Return elements affected by a specific QA issue.
    issue: unclassified | no_geometry | no_name | no_storey | no_material | duplicate_ids
    """
    def _cols(row):
        return {
            "element_id": str(row[0]),
            "speckle_id": row[1],
            "ifc_class":  row[2],
            "category":   row[3],
            "name":       row[4],
            "storey":     row[5],
        }

    with conn.cursor() as cur:
        if issue == "unclassified":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                WHERE e.model_id = %s
                  AND (e.category IS NULL OR e.category ILIKE 'Generic Models' OR e.category ILIKE 'Unknown')
                ORDER BY e.ifc_class NULLS LAST, e.name
                LIMIT %s
            """, (model_id, limit))
        elif issue == "no_geometry":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s AND g.element_id IS NULL
                ORDER BY e.category, e.name
                LIMIT %s
            """, (model_id, limit))
        elif issue == "no_name":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                WHERE e.model_id = %s
                  AND (e.name IS NULL OR TRIM(e.name) = '' OR e.name = 'None')
                ORDER BY e.ifc_class, e.storey
                LIMIT %s
            """, (model_id, limit))
        elif issue == "no_storey":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                WHERE e.model_id = %s
                  AND (e.storey IS NULL OR TRIM(e.storey) = '')
                ORDER BY e.category, e.name
                LIMIT %s
            """, (model_id, limit))
        elif issue == "no_material":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                WHERE e.model_id = %s
                  AND NOT EXISTS (
                    SELECT 1 FROM bim_parameters p
                    WHERE p.element_id = e.element_id
                      AND (p.canonical_key = 'material' OR p.key = ANY(%s))
                      AND p.value IS NOT NULL AND p.value <> ''
                  )
                ORDER BY e.category, e.name
                LIMIT %s
            """, (model_id, _MATERIAL_KEYS, limit))
        elif issue == "duplicate_ids":
            cur.execute("""
                SELECT e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey
                FROM bim_elements e
                WHERE e.model_id = %s
                  AND e.application_id IN (
                    SELECT application_id FROM bim_elements
                    WHERE model_id = %s
                      AND application_id IS NOT NULL AND application_id <> ''
                    GROUP BY application_id HAVING COUNT(*) > 1
                  )
                ORDER BY e.application_id, e.speckle_id
                LIMIT %s
            """, (model_id, model_id, limit))
        else:
            return []

        return [_cols(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Single-element detail lookup by Speckle ID or name (chat agent + viewer
# selection use Speckle IDs, not the internal element_id UUID)
# ---------------------------------------------------------------------------

def get_element_details(conn, model_id: str, reference: str) -> dict | None:
    """
    Look up one element within model_id by exact Speckle ID or partial name
    match, returning its core fields, bbox/centroid/volume/area, and full
    parameter list. Returns None if no element matches.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT e.element_id, e.speckle_id, e.application_id, e.speckle_type,
                   e.ifc_class, e.category, e.name, e.storey,
                   g.bbox_min, g.bbox_max, g.centroid, g.volume_m3, g.area_m2
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s AND (e.speckle_id = %s OR e.name ILIKE %s)
            ORDER BY (e.speckle_id = %s) DESC
            LIMIT 1
        """, (model_id, reference, f"%{reference}%", reference))
        row = cur.fetchone()
        if not row:
            return None
        cols = [d[0] for d in cur.description]
        element = dict(zip(cols, row))
        element["element_id"] = str(element["element_id"])

        cur.execute("""
            SELECT pset, key, value, datatype
            FROM bim_parameters
            WHERE element_id = %s
            ORDER BY pset, key
        """, (row[0],))
        element["parameters"] = [
            dict(zip(["pset", "key", "value", "datatype"], r))
            for r in cur.fetchall()
        ]
    return element


# ---------------------------------------------------------------------------
# Parameter completeness — fill-rate per parameter, worst-covered first
# ---------------------------------------------------------------------------

def get_parameter_completeness(conn, model_id: str, category: str = None,
                                ifc_class: str = None, min_coverage: float = 0.0) -> dict:
    """
    Parameter fill-rate report for a model.
    Returns {model_id, total_elements, parameters: [{canonical_key, key, pset, total, filled, missing, fill_pct}]}
    sorted by coverage ascending (worst first).

    Optional filters:
      category   — restrict to elements of this category (ILIKE)
      ifc_class  — restrict to elements of this IFC class
      min_coverage — only return parameters at or above this fill % (e.g. 99.0 to see near-complete)
    """
    with conn.cursor() as cur:
        elem_where = ["e.model_id = %s"]
        elem_params: list = [model_id]
        if category:
            elem_where.append("e.category ILIKE %s")
            elem_params.append(f"%{category}%")
        if ifc_class:
            elem_where.append("e.ifc_class = %s")
            elem_params.append(ifc_class)
        elem_sql = " AND ".join(elem_where)

        cur.execute(f"SELECT COUNT(*) FROM bim_elements e WHERE {elem_sql}", elem_params)
        total = int(cur.fetchone()[0] or 0)
        if total == 0:
            return {"model_id": model_id, "total_elements": 0, "parameters": []}

        cur.execute(f"""
            SELECT
                COALESCE(p.canonical_key, p.key) AS display_key,
                p.canonical_key,
                p.key,
                p.pset,
                COUNT(DISTINCT p.element_id) AS filled
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE {elem_sql}
            GROUP BY COALESCE(p.canonical_key, p.key), p.canonical_key, p.key, p.pset
            ORDER BY filled DESC
        """, elem_params)
        rows = cur.fetchall()

    grouped: dict[str, dict] = {}
    for display_key, canon, raw_key, pset, filled in rows:
        if display_key not in grouped:
            grouped[display_key] = {
                "canonical_key": canon,
                "key":           display_key,
                "pset":          pset,
                "filled":        0,
            }
        # Take max fill across raw keys mapping to same canonical
        grouped[display_key]["filled"] = max(grouped[display_key]["filled"], filled)

    result = []
    for entry in grouped.values():
        filled = entry["filled"]
        missing = total - filled
        fill_pct = round(filled / total * 100, 1)
        if fill_pct >= min_coverage:
            result.append({
                "canonical_key": entry["canonical_key"],
                "key":           entry["key"],
                "pset":          entry["pset"],
                "total":         total,
                "filled":        filled,
                "missing":       missing,
                "fill_pct":      fill_pct,
            })

    result.sort(key=lambda x: x["fill_pct"])
    return {"model_id": model_id, "total_elements": total, "parameters": result}


# ---------------------------------------------------------------------------
# Version history / trend
# ---------------------------------------------------------------------------

def get_model_stream_id(conn, model_id: str) -> str | None:
    """Return the stream_id for a model, or None if the model doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("SELECT stream_id FROM bim_models WHERE model_id = %s", (model_id,))
        row = cur.fetchone()
        return row[0] if row else None


def get_model_trend(conn, stream_id: str) -> list[dict]:
    """
    Version history for a stream.
    Returns [{model_id, commit_id, branch_name, ingested_at, source, message,
              total_elements, by_category: {cat: count}}]
    ordered oldest -> newest.
    """
    from collections import OrderedDict

    with conn.cursor() as cur:
        cur.execute("""
            SELECT m.model_id::text, m.commit_id, m.branch_name,
                   m.ingested_at, m.source, m.message,
                   e.category, COUNT(*) AS cnt
            FROM bim_models m
            JOIN bim_elements e ON e.model_id = m.model_id
            WHERE m.stream_id = %s
            GROUP BY m.model_id, m.commit_id, m.branch_name,
                     m.ingested_at, m.source, m.message, e.category
            ORDER BY m.ingested_at ASC
        """, (stream_id,))
        rows = cur.fetchall()

    versions: dict = OrderedDict()
    for model_id, commit_id, branch, ingested_at, source, message, cat, cnt in rows:
        if model_id not in versions:
            versions[model_id] = {
                "model_id":       model_id,
                "commit_id":      commit_id,
                "branch_name":    branch or "",
                "ingested_at":    ingested_at.isoformat() if ingested_at else None,
                "source":         source or "",
                "message":        message or "",
                "total_elements": 0,
                "by_category":    {},
            }
        v = versions[model_id]
        v["by_category"][cat or "Unknown"] = int(cnt)
        v["total_elements"] += int(cnt)

    return list(versions.values())


# ---------------------------------------------------------------------------
# Spatial / proximity queries
# ---------------------------------------------------------------------------

def find_nearby_elements(conn, model_id: str, origin, radius_m: float,
                          category: str = None, exclude_speckle_id: str = None) -> list[dict]:
    """
    Find elements within `radius_m` meters of `origin`.

    `origin` is either a literal [x, y, z] coordinate in meters, or a
    speckle_id / element name used to look up a reference element's
    centroid_si. Only elements with a populated centroid_si (ingested after
    the centroid_si column was added) are considered.

    Returns [{speckle_id, name, category, ifc_class, distance_m}] sorted by
    distance ascending, capped at 200 results.
    """
    with conn.cursor() as cur:
        if isinstance(origin, (list, tuple)) and len(origin) == 3:
            x0, y0, z0 = (float(v) for v in origin)
        else:
            cur.execute("""
                SELECT g.centroid_si, e.speckle_id
                FROM bim_elements e
                JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s AND g.centroid_si IS NOT NULL
                  AND (e.speckle_id = %s OR e.name ILIKE %s)
                LIMIT 1
            """, (model_id, origin, f"%{origin}%"))
            row = cur.fetchone()
            if not row:
                return []
            x0, y0, z0 = row[0]
            exclude_speckle_id = exclude_speckle_id or row[1]

        where = ["e.model_id = %s", "g.centroid_si IS NOT NULL"]
        where_params: list = [model_id]
        if exclude_speckle_id:
            where.append("e.speckle_id <> %s")
            where_params.append(exclude_speckle_id)
        if category:
            where.append("e.category ILIKE %s")
            where_params.append(f"%{category}%")
        where.append(
            "sqrt(power(g.centroid_si[1]-%s,2) + power(g.centroid_si[2]-%s,2)"
            " + power(g.centroid_si[3]-%s,2)) <= %s"
        )
        where_params.extend([x0, y0, z0, radius_m])

        cur.execute(f"""
            SELECT e.speckle_id, e.name, e.category, e.ifc_class,
                   sqrt(power(g.centroid_si[1]-%s,2) + power(g.centroid_si[2]-%s,2)
                        + power(g.centroid_si[3]-%s,2)) AS distance_m
            FROM bim_elements e
            JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE {" AND ".join(where)}
            ORDER BY distance_m ASC
            LIMIT 200
        """, [x0, y0, z0] + where_params)

        return [
            {
                "speckle_id": r[0],
                "name":       r[1],
                "category":   r[2],
                "ifc_class":  r[3],
                "distance_m": round(float(r[4]), 3),
            }
            for r in cur.fetchall()
        ]
