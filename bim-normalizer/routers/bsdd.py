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


def _pascal_case(name: str) -> str:
    """Title-cases each word of a bSDD display name (e.g. 'Curtain Wall' ->
    'CurtainWall') while preserving words that are already all-uppercase
    (e.g. 'SI' in 'SI Unit' -> 'SI', not 'Si') since those are typically
    acronyms baked verbatim into the real IFC entity name."""
    return "".join(w if w.isupper() and len(w) > 1 else w[:1].upper() + w[1:].lower() for w in name.split())


def _is_real_ifc_entity(name: str, reference_code: str) -> bool:
    """bSDD's IFC dictionary lists a pseudo-'class' for every (entity,
    PredefinedType) combination too — e.g. searching 'wall' also returns
    referenceCode 'IfcWallELEMENTEDWALL' (name 'Elemented Wall'), which is
    NOT a valid <ids:entity> name (the real entity is IfcWall; ELEMENTEDWALL
    belongs in the separate PredefinedType field). Those pseudo-classes are
    detectable because bSDD's own display `name` no longer round-trips to
    `referenceCode` once title-cased — a genuine entity's does."""
    return f"Ifc{_pascal_case(name)}" == reference_code


@router.get("/ifc-classes")
async def search_ifc_classes(search: str = Query("", description="Filter text, e.g. 'wall'"), limit: int = 30):
    """IFC entity class names (e.g. IFCWALL) from bSDD's official IFC
    dictionary, for the Entity/Part-Of nodes' 'IFC Class' autocomplete.
    Unlike /classes, this hardcodes the IFC dictionary URI so the frontend
    doesn't need to know it. Empty search returns no results (200, not an
    error) rather than listing bSDD's entire IFC dictionary — callers fall
    back to a short hardcoded common-classes list for that case instead."""
    query = search.strip()
    if not query:
        return {"classes": []}
    # Over-fetch since _is_real_ifc_entity filters out a good chunk of
    # matches (every PredefinedType pseudo-class) — without this a search
    # like "wall" would return only a few real entities out of `limit` raw
    # results even though many more genuine matches exist.
    data = await _bsdd_get("/Class/Search/v1", {
        "SearchText": query,
        "DictionaryUris": IFC_DICTIONARY_URI,
        "Limit": max(limit * 4, 100),
    })
    classes = [
        {"name": c["referenceCode"], "description": c.get("description")}
        for c in data.get("classes", [])
        if c.get("referenceCode") and _is_real_ifc_entity(c.get("name", ""), c["referenceCode"])
    ]
    return {"classes": classes[:limit]}


@router.get("/ifc-predefined-types")
async def ifc_predefined_types(ifc_class: str = Query(..., description="IFC entity name, e.g. IFCWALL")):
    """PredefinedType enum values bSDD associates with an IFC entity (e.g.
    ELEMENTEDWALL, SOLIDWALL, ... for IFCWALL), for the Entity node's
    'Predefined Type' field. This is the mirror image of the pseudo-classes
    _is_real_ifc_entity filters out of /ifc-classes: searching bSDD for the
    entity's own reference code returns exactly that entity plus every one
    of its (entity, PredefinedType) pseudo-classes, whose referenceCode is
    the entity's own code with the enum value appended verbatim
    (IfcWall -> IfcWallELEMENTEDWALL) — so the suffix after stripping the
    entity's code back off *is* the PredefinedType value."""
    try:
        resolved = await _resolve_ifc_class_uri(ifc_class)
    except HTTPException:
        resolved = None
    if not resolved:
        return {"resolved": False, "types": []}
    _, class_reference_code = resolved

    try:
        data = await _bsdd_get("/Class/Search/v1", {
            "SearchText": class_reference_code,
            "DictionaryUris": IFC_DICTIONARY_URI,
            "Limit": 100,
        })
    except HTTPException:
        return {"resolved": True, "types": []}

    types = []
    for c in data.get("classes", []):
        code = c.get("referenceCode", "")
        if not code.startswith(class_reference_code) or code == class_reference_code:
            continue
        suffix = code[len(class_reference_code):]
        if suffix.isupper():  # excludes an unrelated longer entity name sharing this prefix
            types.append({"value": suffix, "description": c.get("description")})
    return {"resolved": True, "types": types}


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
