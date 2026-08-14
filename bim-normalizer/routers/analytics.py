from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

router = APIRouter(tags=["analytics"])


@router.get("/diff/{model_a}/{model_b}")
def diff_models(model_a: str, model_b: str):
    from db.connection import get_conn, release_conn
    from db.query import get_model_diff
    conn = get_conn()
    try:
        d = get_model_diff(conn, model_a, model_b)
        return {
            "model_a":       model_a,
            "model_b":       model_b,
            "added_count":   len(d["added"]),
            "removed_count": len(d["removed"]),
            "changed_count": len(d["changed"]),
            "current_total": d["current_total"],
            "other_total":   d["other_total"],
            "total_delta":   d["current_total"] - d["other_total"],
            "element_ids":   [r["speckle_id"] for r in d["added"]],    # speckle_ids of added elements
            "removed_ids":   [r["speckle_id"] for r in d["removed"]],
            "changed_elements": d["changed"],
            "category_changes": d["category_changes"],
        }
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/summary")
def get_model_summary(model_id: str):
    """
    Chart-ready aggregations for one normalised model.
    Returns counts + volume + area grouped by category, ifc_class, storey,
    plus parameter-derived distributions: material, profile, grade.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_summary as _summary
    conn = get_conn()
    try:
        # Verify model exists
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _summary(conn, model_id)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/location")
def get_model_location(model_id: str):
    """
    Geographic location (lat/lon/elevation) derived from the model's IfcSite
    element, for the dashboard's map widget. lat/lon are None when the model
    has no IfcSite geo-reference (e.g. ingested directly from a live Revit
    connector rather than an uploaded IFC file) — not a 404, since "no
    location data" is an expected, valid state for the widget to render.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_location as _location
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _location(conn, model_id)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/qa")
def get_model_qa(model_id: str):
    """
    BIM data-quality assessment: missing names/storeys/geometry/materials,
    unclassified elements, duplicate application IDs, and a 0–1 quality score.
    """
    from db.connection import get_conn, release_conn
    from db.query import get_model_qa as _qa
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qa(conn, model_id)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/qa/elements")
def get_model_qa_elements(model_id: str, issue: str, limit: int = 50):
    """
    Return the actual elements affected by a specific QA issue.
    issue: unclassified | no_geometry | no_name | no_storey | no_material | duplicate_ids
    Use GET /models/{model_id}/qa first to see issue counts.
    """
    VALID = {"unclassified", "no_geometry", "no_name", "no_storey", "no_material", "duplicate_ids"}
    if issue not in VALID:
        raise HTTPException(status_code=422, detail=f"issue must be one of: {', '.join(sorted(VALID))}")
    from db.connection import get_conn, release_conn
    from db.query import get_qa_elements as _qa_el
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        return _qa_el(conn, model_id, issue, limit)
    finally:
        release_conn(conn)


@router.get("/models/{model_id}/export/csv")
def export_model_csv(
    model_id: str,
    category: str = None,
    ifc_class: str = None,
    storey: str = None,
):
    """
    Export elements as a streaming CSV with geometry quantities and key parameter fields.
    Columns: element_id, speckle_id, ifc_class, category, name, storey,
             volume_m3, area_m2, material, profile, grade
    """
    import csv
    import io
    from db.connection import get_conn, release_conn
    from db.query import get_elements_flat as _flat

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
        result = _flat(conn, model_id, limit=999_999, offset=0,
                       category=category, ifc_class=ifc_class, storey=storey)
    finally:
        release_conn(conn)

    def _generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "element_id", "speckle_id", "ifc_class", "category", "name",
            "storey", "volume_m3", "area_m2", "material", "profile", "grade",
        ])
        yield buf.getvalue()
        for el in result.get("elements", []):
            buf = io.StringIO()
            writer = csv.writer(buf)
            writer.writerow([
                el.get("element_id", ""),
                el.get("speckle_id", ""),
                el.get("ifc_class", ""),
                el.get("category", ""),
                el.get("name", ""),
                el.get("storey", ""),
                el.get("volume_m3", ""),
                el.get("area_m2", ""),
                el.get("material", ""),
                el.get("profile", ""),
                el.get("grade", ""),
            ])
            yield buf.getvalue()

    filename = f"model_{model_id[:8]}.csv"
    return StreamingResponse(
        _generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
