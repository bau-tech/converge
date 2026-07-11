import asyncio
import logging

from fastapi import APIRouter, HTTPException

from routers.ingest import IngestRequest

router = APIRouter(tags=["debug"])
logger = logging.getLogger(__name__)


@router.get("/debug/inspect/{stream_id}/{commit_id}")
async def debug_inspect(stream_id: str, commit_id: str, limit: int = 5, offset: int = 0):
    """
    Fetch a Speckle commit (without storing) and report geometry structure.

    Returns:
    - category_breakdown: how many elements per category have/lack geometry
    - with_geometry:    first `limit` elements that have usable mesh data
    - without_geometry: `limit` elements starting at `offset` that have NO mesh
                        (use offset to page through the 839 to see what they are)
    """
    from speckle.fetch import fetch_commit, flatten_elements
    from ifc.geometry import _get_all_meshes
    from specklepy.objects import Base

    def _inspect():
        root, meta = fetch_commit(stream_id, commit_id)
        element_tuples = flatten_elements(root)

        def _dv_summary(obj):
            dv = getattr(obj, "displayValue", None)
            if dv is None:
                try:
                    dv = obj["@displayValue"]
                except Exception:
                    pass
            if dv is None:
                return None
            dv_list = dv if isinstance(dv, list) else [dv]
            out = []
            for item in dv_list:
                if not isinstance(item, Base):
                    out.append({"kind": type(item).__name__})
                    continue
                verts = getattr(item, "vertices", None) or getattr(item, "@vertices", None)
                n = 0
                first_t = "n/a"
                if verts and isinstance(verts, (list, tuple)) and len(verts) > 0:
                    first_t = type(verts[0]).__name__
                    if first_t in ("int", "float"):
                        n = len(verts) // 3
                out.append({
                    "speckle_type": getattr(item, "speckle_type", "?"),
                    "vertex_count": n,
                    "first_vertex_type": first_t,
                })
            return out

        def _elem_info(obj, hint=""):
            cat = getattr(obj, "category", None)
            if cat is None:
                props = getattr(obj, "properties", None) or {}
                cat = props.get("category") or props.get("Category") or ""
            return {
                "id":             getattr(obj, "id", "?"),
                "applicationId":  getattr(obj, "applicationId", None),
                "speckle_type":   getattr(obj, "speckle_type", "?"),
                "category":       str(cat) if cat else "",
                "category_hint":  hint,
                "name":           getattr(obj, "name", None) or getattr(obj, "type", None) or "",
                "displayValue":   _dv_summary(obj),
            }

        # Split into geo / no-geo using the same function as the ingest
        with_geo = []
        without_geo = []
        cat_with: dict[str, int] = {}
        cat_without: dict[str, int] = {}

        for obj, hint in element_tuples:
            cat = str(getattr(obj, "category", "") or hint or "")
            meshes = _get_all_meshes(obj)
            if meshes:
                with_geo.append((obj, hint))
                cat_with[cat] = cat_with.get(cat, 0) + 1
            else:
                without_geo.append((obj, hint))
                cat_without[cat] = cat_without.get(cat, 0) + 1

        return {
            "commit": meta,
            "total_elements":    len(element_tuples),
            "with_geometry":     len(with_geo),
            "without_geometry":  len(without_geo),
            "category_breakdown": {
                "with_geometry":    dict(sorted(cat_with.items(),    key=lambda x: -x[1])),
                "without_geometry": dict(sorted(cat_without.items(), key=lambda x: -x[1])),
            },
            "samples_with_geometry":    [_elem_info(o, h) for o, h in with_geo[:limit]],
            "samples_without_geometry": [_elem_info(o, h) for o, h in without_geo[offset:offset + limit]],
        }

    try:
        return await asyncio.to_thread(_inspect)
    except Exception as exc:
        logger.error("Inspect error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/debug/classify-inspect")
async def debug_classify_inspect(request: IngestRequest, limit: int = 20):
    """
    Fetch a Speckle commit (without storing) and show the raw classification
    signals on the first `limit` elements.  Use this to diagnose why Tekla
    (or any other source) elements are landing in 'Generic Models'.

    Returns for each element:
      speckle_type, obj.type, obj.category, obj.name,
      properties_keys (first 20 keys from the properties bag),
      classified_as (what classify_element would return)
    """
    from speckle.fetch import fetch_commit, flatten_elements
    from ifc.classify import classify_element

    def _run():
        root, meta = fetch_commit(request.stream_id, request.commit_id, token=request.token)
        tuples = flatten_elements(root)
        results = []
        for obj, hint in tuples[:limit]:
            st = getattr(obj, "speckle_type", "") or ""
            obj_type = getattr(obj, "type", None)
            obj_cat = getattr(obj, "category", None)
            obj_name = getattr(obj, "name", None)

            # Collect properties keys so we can see what's in the bag
            prop_keys = []
            for attr in ("properties", "parameters", "typeParameters"):
                bag = getattr(obj, attr, None)
                if isinstance(bag, dict):
                    prop_keys = list(bag.keys())[:30]
                    break
                elif hasattr(bag, "__dict__"):
                    prop_keys = list(bag.__dict__.keys())[:30]
                    break

            # Sample property values for category-like keys
            prop_category = None
            for attr in ("properties", "parameters"):
                bag = getattr(obj, attr, None)
                if isinstance(bag, dict):
                    for k in ("category", "Category", "CATEGORY", "CLASS", "class", "Type", "type"):
                        v = bag.get(k)
                        if v is not None:
                            prop_category = f"{k}={v!r}"
                            break
                if prop_category:
                    break

            # All top-level attribute keys on the object
            try:
                obj_keys = sorted(k for k in obj.__dict__.keys() if not k.startswith("__"))[:30]
            except Exception:
                obj_keys = []

            classification = classify_element(st, obj, hint)

            results.append({
                "speckle_type":     st,
                "obj_type":         str(obj_type) if obj_type is not None else None,
                "obj_category":     str(obj_cat) if obj_cat is not None else None,
                "obj_name":         str(obj_name) if obj_name is not None else None,
                "category_hint":    hint or None,
                "prop_category":    prop_category,
                "properties_keys":  prop_keys,
                "obj_keys":         obj_keys,
                "classified_as":    classification,
            })

        # Also show category distribution across ALL elements
        from collections import Counter
        all_cats = Counter(
            classify_element(
                getattr(o, "speckle_type", "") or "",
                o, h
            )["category"]
            for o, h in tuples
        )

        return {
            "commit": meta,
            "total_elements": len(tuples),
            "category_distribution": dict(all_cats.most_common()),
            "element_samples": results,
        }

    try:
        return await asyncio.to_thread(_run)
    except Exception as exc:
        logger.error("classify-inspect error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
