from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

router = APIRouter(tags=["analytics"])


@router.get("/diff/{model_a}/{model_b}")
def diff_models(model_a: str, model_b: str):
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Added in B (exist in B, not in A)
            cur.execute("""
                SELECT b.speckle_id, b.ifc_class, b.category, b.name
                FROM bim_elements b
                WHERE b.model_id = %s
                  AND b.application_id IS NOT NULL
                  AND b.application_id <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM bim_elements a
                      WHERE a.model_id = %s AND a.application_id = b.application_id
                  )
            """, (model_b, model_a))
            added = cur.fetchall()
            added_cols = [d[0] for d in cur.description]

            # Removed from A (exist in A, not in B)
            cur.execute("""
                SELECT a.speckle_id, a.ifc_class, a.category, a.name
                FROM bim_elements a
                WHERE a.model_id = %s
                  AND a.application_id IS NOT NULL
                  AND a.application_id <> ''
                  AND NOT EXISTS (
                      SELECT 1 FROM bim_elements b
                      WHERE b.model_id = %s AND b.application_id = a.application_id
                  )
            """, (model_a, model_b))
            removed = cur.fetchall()

            # Changed (same application_id, different hash)
            cur.execute("""
                SELECT a.speckle_id AS speckle_id_a, b.speckle_id AS speckle_id_b,
                       a.category, a.name
                FROM bim_elements a
                JOIN bim_elements b ON a.application_id = b.application_id
                WHERE a.model_id = %s AND b.model_id = %s
                  AND a.hash != b.hash
                  AND a.application_id IS NOT NULL
                  AND a.application_id <> ''
            """, (model_a, model_b))
            changed = cur.fetchall()
            changed_cols = [d[0] for d in cur.description]

            # Category delta (B = current/newer, A = older/base)
            cur.execute("""
                SELECT COALESCE(a.category, b.category) AS category,
                       COALESCE(a.cnt, 0) AS current_count,
                       COALESCE(b.cnt, 0) AS other_count,
                       COALESCE(a.cnt, 0) - COALESCE(b.cnt, 0) AS delta
                FROM
                    (SELECT category, COUNT(*) cnt FROM bim_elements WHERE model_id = %s GROUP BY category) a
                FULL OUTER JOIN
                    (SELECT category, COUNT(*) cnt FROM bim_elements WHERE model_id = %s GROUP BY category) b
                ON a.category = b.category
                ORDER BY ABS(COALESCE(a.cnt,0) - COALESCE(b.cnt,0)) DESC
            """, (model_b, model_a))
            cat_rows = cur.fetchall()

            # Total element counts so the frontend can show "Unchanged" correctly
            cur.execute("""
                SELECT
                    SUM(CASE WHEN model_id = %s THEN 1 ELSE 0 END) AS current_total,
                    SUM(CASE WHEN model_id = %s THEN 1 ELSE 0 END) AS other_total
                FROM bim_elements
                WHERE model_id IN (%s, %s)
            """, (model_b, model_a, model_a, model_b))
            totals_row = cur.fetchone()
            current_total = int(totals_row[0] or 0)
            other_total   = int(totals_row[1] or 0)

        category_changes = [
            {"category": r[0] or "Unknown", "current_count": r[1], "other_count": r[2], "delta": r[3]}
            for r in cat_rows if r[3] != 0
        ]

        return {
            "model_a":       model_a,
            "model_b":       model_b,
            "added_count":   len(added),
            "removed_count": len(removed),
            "changed_count": len(changed),
            "current_total": current_total,
            "other_total":   other_total,
            "total_delta":   current_total - other_total,
            "element_ids":   [r[0] for r in added],    # speckle_ids of added elements
            "removed_ids":   [r[0] for r in removed],
            "changed_elements": [dict(zip(changed_cols, r)) for r in changed],
            "category_changes": category_changes,
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
