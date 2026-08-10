import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(tags=["overrides"])
logger = logging.getLogger(__name__)


class OverrideItem(BaseModel):
    application_id: str | None = None
    speckle_id: str | None = None
    ifc_class: str
    category: str
    note: str | None = None


@router.get("/models/{model_id}/overrides")
def list_overrides(model_id: str):
    """Return all per-element classification overrides for a model."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            cur.execute("""
                SELECT override_id, model_id, application_id, speckle_id,
                       ifc_class, category, note, created_at
                FROM bim_classification_overrides
                WHERE model_id = %s
                ORDER BY created_at DESC
            """, (model_id,))
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/overrides")
def upsert_overrides(model_id: str, items: list[OverrideItem]):
    """
    Bulk-upsert classification overrides. Matches by application_id when present,
    otherwise by speckle_id. At least one of the two must be provided per item.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")

            upserted = 0
            for item in items:
                if not item.application_id and not item.speckle_id:
                    raise HTTPException(
                        status_code=422,
                        detail="Each override must have application_id or speckle_id"
                    )
                # The table has two separate partial unique indexes —
                # idx_overrides_appid (model_id, application_id) WHERE
                # application_id IS NOT NULL, and idx_overrides_speckleid
                # (model_id, speckle_id) WHERE speckle_id IS NOT NULL (see
                # db/models.py). ON CONFLICT can only name one arbiter, so an
                # item matched by speckle_id alone (application_id NULL) must
                # use the speckle_id index — naming the application_id index
                # unconditionally meant a second upsert of the same
                # speckle_id-only item never matched that arbiter and instead
                # raised an unhandled UniqueViolation against
                # idx_overrides_speckleid.
                conflict_target = (
                    "(model_id, application_id) WHERE application_id IS NOT NULL"
                    if item.application_id
                    else "(model_id, speckle_id) WHERE speckle_id IS NOT NULL"
                )
                cur.execute(f"""
                    INSERT INTO bim_classification_overrides
                        (model_id, application_id, speckle_id, ifc_class, category, note)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT {conflict_target}
                    DO UPDATE SET
                        ifc_class  = EXCLUDED.ifc_class,
                        category   = EXCLUDED.category,
                        note       = EXCLUDED.note,
                        created_at = NOW()
                """, (model_id, item.application_id, item.speckle_id,
                      item.ifc_class, item.category, item.note))
                upserted += 1
        conn.commit()
        return {"upserted": upserted}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.delete("/models/{model_id}/overrides/{override_id}")
def delete_override(model_id: str, override_id: str):
    """Delete a single classification override by its UUID."""
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM bim_classification_overrides
                WHERE override_id = %s AND model_id = %s
                RETURNING override_id
            """, (override_id, model_id))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Override not found")
        conn.commit()
        return {"deleted": override_id}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.post("/models/{model_id}/overrides/apply")
def apply_overrides(model_id: str):
    """
    Apply all stored overrides for a model: UPDATE bim_elements.ifc_class / category
    wherever an override matches by application_id or speckle_id.
    Returns the number of elements updated.
    """
    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM bim_models WHERE model_id = %s", (model_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Model not found")
            cur.execute("""
                UPDATE bim_elements e
                SET ifc_class = o.ifc_class,
                    category  = o.category
                FROM bim_classification_overrides o
                WHERE o.model_id = e.model_id
                  AND o.model_id = %s
                  AND (
                      (o.application_id IS NOT NULL AND o.application_id = e.application_id)
                   OR (o.speckle_id     IS NOT NULL AND o.speckle_id     = e.speckle_id)
                  )
            """, (model_id,))
            updated = cur.rowcount
        conn.commit()
        from chat.agent import invalidate_model_query_cache
        invalidate_model_query_cache(model_id)
        logger.info("Applied %d overrides to model %s", updated, model_id)
        return {"updated": updated}
    except HTTPException:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        release_conn(conn)


@router.post("/classification/reload")
def reload_classification():
    """
    Re-read all mapping config files from disk without restarting the service.
    Covers mapping_revit.json, mapping_ifc_class.json, and mapping_canonical.json.
    """
    from ifc.classify import reload_classification_maps
    reload_classification_maps()
    # Reload canonical parameter mapping
    import db.insert as _insert
    _insert._KEY_TO_CANONICAL, _insert._PSET_KEY_TO_CANONICAL = _insert._load_canonical_map()
    return {"status": "reloaded"}
