"""
Server-side proxy to the buildingSMART Data Dictionary (bSDD) public API,
powering the IDS visual editor's property/classification pickers.

bSDD refuses real cross-origin browser calls: it answers with HTTP 200 and
an EMPTY body whenever a request carries an Origin header that isn't on its
allow-list (verified by hand — no CORS headers are ever sent back either),
so the frontend cannot call api.bsdd.buildingsmart.org directly. This
router calls it server-to-server (no Origin header) and re-serves the
result, with an in-memory cache since bSDD rate-limits aggressively and
dictionary/class/property data changes on the order of months, not
requests.

Note bSDD's own `dataType` field is deliberately coarse (Boolean/String/
Real/Integer/...) — it does not carry IFC's specific measure types (e.g.
`IfcThermalTransmittanceMeasure`). Where bSDD knows the precise type it
says so only in prose inside `description`, so `_suggest_ifc_type` maps to
the closest generic IFC simple type and the frontend surfaces the raw
description alongside it as a hint.
"""
import logging
import time

import httpx
from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/bsdd", tags=["bsdd"])
logger = logging.getLogger(__name__)

BSDD_BASE = "https://api.bsdd.buildingsmart.org/api"
IFC_DICTIONARY_URI = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3"

_CACHE_TTL_SECONDS = 3600
_cache: dict[str, tuple[float, object]] = {}

# bSDD's generic dataType -> closest generic IFC simple/measure type. Coarse
# on purpose: bSDD doesn't expose the exact IFC measure type, so this is a
# starting suggestion, not a validated answer.
BSDD_TO_IFC_TYPE = {
    "Boolean": "IFCBOOLEAN",
    "Integer": "IFCINTEGER",
    "Real": "IFCREAL",
    "String": "IFCLABEL",
    "Time": "IFCDATETIME",
}


async def _bsdd_get(path: str, params: dict) -> dict:
    clean_params = {k: v for k, v in params.items() if v is not None}
    cache_key = path + "?" + "&".join(f"{k}={v}" for k, v in sorted(clean_params.items()))
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if cached and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{BSDD_BASE}{path}", params=clean_params)
    except httpx.RequestError as exc:
        logger.warning("bSDD request error: %s %s -> %s", path, clean_params, exc)
        raise HTTPException(status_code=502, detail="bSDD is unreachable")

    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="bSDD rate limit exceeded, try again shortly")
    if resp.status_code >= 400:
        logger.warning("bSDD request failed: %s %s -> %s", path, clean_params, resp.status_code)
        raise HTTPException(status_code=502, detail=f"bSDD request failed ({resp.status_code})")

    data = resp.json()
    _cache[cache_key] = (now, data)
    return data


async def _resolve_ifc_class_uri(ifc_class: str) -> tuple[str, str] | None:
    """Find the bSDD class URI for an IFC entity name (e.g. 'IFCWALL' or
    'IfcWall'). bSDD's search is a case-insensitive substring match over
    both display name and reference code, so an exact reference-code match
    is picked out of the results rather than assumed from the query."""
    name = ifc_class.strip()
    if not name:
        return None
    data = await _bsdd_get("/Class/Search/v1", {
        "SearchText": name,
        "DictionaryUris": IFC_DICTIONARY_URI,
        "Limit": 50,
    })
    for cls in data.get("classes", []):
        if cls.get("referenceCode", "").lower() == name.lower():
            return cls["uri"], cls["referenceCode"]
    return None


@router.get("/entity-properties")
async def entity_properties(ifc_class: str = Query(..., description="IFC entity name, e.g. IFCWALL")):
    """Property sets + properties bSDD associates with an IFC class, grouped
    by property set, for the IDS Property node's autocomplete. Degrades to
    `resolved: false` (200, not an error) when the class can't be matched or
    bSDD can't be reached, since callers should fall back to free-text
    entry rather than surface a hard error for an unrecognized/custom
    entity name."""
    try:
        resolved = await _resolve_ifc_class_uri(ifc_class)
    except HTTPException:
        resolved = None
    if not resolved:
        return {"resolved": False, "className": None, "propertySets": []}
    class_uri, class_name = resolved

    try:
        data = await _bsdd_get("/Class/Properties/v1", {"ClassUri": class_uri, "Limit": 1000})
    except HTTPException:
        return {"resolved": False, "className": class_name, "propertySets": []}

    by_set: dict[str, list[dict]] = {}
    for prop in data.get("classProperties", []):
        pset = prop.get("propertySet") or "Attributes"
        by_set.setdefault(pset, []).append({
            "baseName": prop.get("propertyCode"),
            "bsddDataType": prop.get("dataType"),
            "suggestedIfcType": BSDD_TO_IFC_TYPE.get(prop.get("dataType")),
            "description": prop.get("description"),
            "propertyUri": prop.get("propertyUri"),
        })

    property_sets = [
        {"name": pset, "properties": props}
        for pset, props in sorted(by_set.items())
        if pset != "Attributes"  # native IFC attributes, not property-set properties — irrelevant to the Property node
    ]
    return {"resolved": True, "className": class_name, "propertySets": property_sets}


@router.get("/dictionaries")
async def search_dictionaries(search: str = Query("", description="Filter text, e.g. 'uniclass'"), limit: int = 20):
    """Full dictionary list is cached whole (long TTL, ~a few hundred KB) and
    filtered here rather than re-querying bSDD per keystroke."""
    data = await _bsdd_get("/Dictionary/v1", {})
    dictionaries = data.get("dictionaries", [])
    needle = search.strip().lower()
    if needle:
        dictionaries = [d for d in dictionaries if needle in d.get("name", "").lower()]
    dictionaries = [d for d in dictionaries if d.get("isLatestVersion")]
    return {
        "dictionaries": [
            {
                "uri": d["uri"],
                "name": d["name"],
                "version": d.get("version"),
                "organizationNameOwner": d.get("organizationNameOwner"),
            }
            for d in dictionaries[:limit]
        ]
    }


@router.get("/classes")
async def search_classes(
    dictionary_uri: str = Query(..., description="A dictionary URI from GET /bsdd/dictionaries"),
    search: str = Query(..., min_length=1),
    limit: int = 20,
):
    data = await _bsdd_get("/Class/Search/v1", {
        "SearchText": search,
        "DictionaryUris": dictionary_uri,
        "Limit": limit,
    })
    return {
        "classes": [
            {
                "uri": c["uri"],
                "name": c.get("name"),
                "referenceCode": c.get("referenceCode"),
                "description": c.get("description"),
                "parentClassName": c.get("parentClassName"),
            }
            for c in data.get("classes", [])
        ]
    }
