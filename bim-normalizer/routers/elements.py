from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["elements"])


@router.get("/models/{model_id}/elements")
def get_elements(model_id: str, category: str = None, ifc_class: str = None,
                 storey: str = None, name: str = None, speckle_id: str = None,
                 limit: int = 500, offset: int = 0):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
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
        if name:
            where.append("e.name ILIKE %s")
            params.append(f"%{name}%")
        if speckle_id:
            where.append("e.speckle_id = %s")
            params.append(speckle_id)
        params += [limit, offset]

        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT element_id, application_id, speckle_id, speckle_type,
                       ifc_class, category, name, storey, hash
                FROM bim_elements e
                WHERE {' AND '.join(where)}
                ORDER BY category, name
                LIMIT %s OFFSET %s
            """, params)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        release_conn(conn)


@router.get("/elements/{element_id}")
def get_element(element_id: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT e.*, g.bbox_min, g.bbox_max, g.centroid, g.volume_m3, g.area_m2
                FROM bim_elements e
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.element_id = %s
            """, (element_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Element not found")
            cols = [d[0] for d in cur.description]
            element = dict(zip(cols, row))

            cur.execute("""
                SELECT pset, key, value, datatype
                FROM bim_parameters
                WHERE element_id = %s
                ORDER BY pset, key
            """, (element_id,))
            element["parameters"] = [
                dict(zip(["pset", "key", "value", "datatype"], r))
                for r in cur.fetchall()
            ]
        return element
    finally:
        release_conn(conn)


@router.get("/elements/{element_id}/relationships")
def get_element_relationships_route(element_id: str):
    """
    Elements directly related to element_id (parent/room/space references
    resolved at ingest time — see db/insert.py's build_relationships()).
    Returns [] for models ingested before this existed, or where the
    referenced elements (e.g. Rooms/Spaces) weren't captured during ingest.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_element_relationships
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_elements WHERE element_id = %s", (element_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Element not found")
        return get_element_relationships(conn, element_id)
    finally:
        release_conn(conn)


@router.get("/elements/{element_id}/connectivity")
def get_element_connectivity_route(element_id: str, hops: int = 2):
    """
    Bounded-hop connectivity graph around element_id — structural/IFC
    relationships (see get_element_relationships_route above; now also real
    IFC relationships where a usable IFC representation exists, not just
    Revit's parent/room/space) plus geometric bounding-box "touching" edges,
    the one signal available for every model regardless of source — see
    db/query.py's get_element_connectivity for the full algorithm.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_element_connectivity
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT model_id FROM bim_elements WHERE element_id = %s", (element_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Element not found")
        return get_element_connectivity(conn, str(row[0]), element_id, hops=hops)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/elements/flat")
def get_elements_flat(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    storey: str = None,
    limit: int = 50000,
    offset: int = 0,
):
    """
    Flat element list enriched with geometry quantities and key parameter fields
    (material, profile, grade). The `id` field mirrors `speckle_id` so the
    dashboard viewer sync works without frontend changes.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_elements_flat as _flat
    conn = get_conn()
    try:
        return _flat(conn, model_id, limit=limit, offset=offset,
                     category=category, ifc_class=ifc_class, storey=storey)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/parameters/completeness")
def get_parameter_completeness(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    min_coverage: float = 0.0,
):
    """
    Parameter fill-rate report for a model.
    Returns [{canonical_key, key, pset, total, filled, missing, fill_pct}]
    sorted by coverage ascending (worst first).

    Optional filters:
      category   — restrict to elements of this category (ILIKE)
      ifc_class  — restrict to elements of this IFC class
      min_coverage — only return parameters below this fill % (e.g. 99.0 to see near-complete)
    """
    from db.connection import get_conn, release_conn
    from db.query import get_parameter_completeness as _completeness
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _completeness(conn, model_id, category=category, ifc_class=ifc_class, min_coverage=min_coverage)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/parameters/keys")
def get_parameter_keys(model_id: str):
    """Return all distinct BIM parameter keys for this model, sorted by element coverage."""
    from db.connection import get_conn, release_conn
    from db.query import get_parameter_keys as _keys
    conn = get_conn()
    try:
        return _keys(conn, model_id)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/elements/nearby")
def get_elements_nearby(
    model_id: str,
    reference: str = None,
    x: float = None,
    y: float = None,
    z: float = None,
    radius_m: float = 5.0,
    category: str = None,
):
    """
    Find elements within `radius_m` meters of a reference element (speckle_id
    or name, via `reference`) or an explicit [x, y, z] coordinate in meters.

    Only elements with a populated `centroid_si` (ingested after this feature
    was added) are matched — older models need re-ingestion for proximity
    search to return results.
    """
    from db.connection import get_conn, release_conn
    from db.query import find_nearby_elements as _nearby

    if reference is None and (x is None or y is None or z is None):
        raise HTTPException(status_code=400, detail="Provide either 'reference' or all of x, y, z")

    origin = reference if reference is not None else [x, y, z]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        matches = _nearby(conn, model_id, origin=origin, radius_m=radius_m, category=category)
        return {"model_id": model_id, "radius_m": radius_m, "count": len(matches), "elements": matches}
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/elements/semantic-search")
def get_elements_semantic_search(model_id: str, query: str, limit: int = 10):
    """
    Rank elements by semantic similarity to a free-text `query` (e.g. "fire
    rated door", "load bearing column") instead of requiring an exact
    name/parameter match. Backed by embeddings computed at ingest time
    (search/embeddings.py) — models ingested before this feature existed (or
    where the embed step failed) return an empty list, not an error.
    """
    from db.connection import get_conn, release_conn
    from db.query import semantic_search_elements

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        matches = semantic_search_elements(conn, model_id, query, limit=limit)
        return {"model_id": model_id, "query": query, "count": len(matches), "elements": matches}
    except HTTPException:
        raise
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/embeddings/status")
def get_embeddings_status(model_id: str):
    """
    How much of this model's semantic-search indexing (search/embeddings.py)
    has completed — embeddings now generate as a background step *after* the
    ingest job itself already reports complete (see
    pipeline.normalize.generate_embeddings_for_model), so this is the only
    way to know whether semantic search is actually going to return results
    yet for a freshly-ingested model.
    """
    from db.connection import get_conn, release_conn

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            cur.execute("SELECT COUNT(*) FROM bim_elements WHERE model_id = %s", (model_id,))
            total = cur.fetchone()[0]
            cur.execute(
                """
                SELECT COUNT(*) FROM bim_element_embeddings emb
                JOIN bim_elements e ON e.element_id = emb.element_id
                WHERE e.model_id = %s
                """,
                (model_id,),
            )
            embedded = cur.fetchone()[0]
        return {
            "model_id": model_id,
            "total_elements": total,
            "embedded_count": embedded,
            "ready": total > 0 and embedded >= total,
        }
    except HTTPException:
        raise
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/elements/by-parameter")
def get_elements_by_parameter(
    model_id: str,
    key: str,
    value: str = "",
    op: str = "contains",
    limit: int = 100,
):
    """
    Filter elements by a BIM parameter key/value with optional numeric operator.
    op: 'contains' (default ILIKE), 'eq', 'gt', 'lt', 'gte', 'lte' (numeric).
    """
    from db.connection import get_conn, release_conn
    _OP_SQL = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
    allowed = {"contains", "eq"} | set(_OP_SQL)
    if op not in allowed:
        raise HTTPException(status_code=422, detail=f"op must be one of: {sorted(allowed)}")

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")

            where = ["e.model_id = %s", "p.key ILIKE %s"]
            params: list = [model_id, f"%{key}%"]

            if op == "contains":
                where.append("p.value ILIKE %s")
                params.append(f"%{value}%")
            elif op == "eq":
                where.append("(p.value ILIKE %s OR (p.value_numeric IS NOT NULL AND p.value_numeric = %s))")
                try:
                    params += [value, float(value)]
                except ValueError:
                    params += [value, None]
            else:
                try:
                    num = float(value)
                except ValueError:
                    raise HTTPException(status_code=422, detail="Numeric value required for gt/lt/gte/lte")
                where.append(f"p.value_numeric {_OP_SQL[op]} %s AND p.value_numeric IS NOT NULL")
                params.append(num)

            params.append(limit)
            cur.execute(f"""
                SELECT DISTINCT ON (e.element_id)
                    e.element_id, e.speckle_id, e.ifc_class, e.category, e.name, e.storey,
                    p.key AS param_key, p.value AS param_value
                FROM bim_elements e
                JOIN bim_parameters p ON p.element_id = e.element_id
                WHERE {' AND '.join(where)}
                ORDER BY e.element_id
                LIMIT %s
            """, params)
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    except HTTPException:
        raise
    finally:
        release_conn(conn)
