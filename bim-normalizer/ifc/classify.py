import hashlib
import json
import logging
import math
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

from specklepy.objects import Base

_CONFIG_DIR = os.path.join(os.path.dirname(__file__), "..", "config")

# speckle_type → {ifc_class, category} — loaded from mapping_ifc.json
# Hard crash on missing/corrupt file is intentional: an empty map would silently
# misclassify every element as Generic Models.
with open(os.path.join(_CONFIG_DIR, "mapping_ifc.json"), encoding="utf-8") as _f:
    _MAPPING: dict[str, dict] = json.load(_f)

_FALLBACK = {"ifc_class": "IfcBuildingElementProxy", "category": "Generic Models"}


def _load_map_file(filename: str, fallback: dict) -> dict:
    """Load a JSON config map, stripping comment keys. Returns fallback on error."""
    path = os.path.join(_CONFIG_DIR, filename)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return {k: v for k, v in data.items() if not k.startswith("_")}
    except Exception as exc:
        logger.warning("Could not load %s: %s — using built-in defaults", filename, exc)
        return fallback


# Loaded at import time; call reload_classification_maps() to pick up edits without restart.
_REVIT_CATEGORY_MAP: dict[str, dict] = {}
_IFC_CLASS_TO_CATEGORY: dict[str, str] = {}


def reload_classification_maps() -> None:
    """Re-read mapping_revit.json and mapping_ifc_class.json from disk."""
    global _REVIT_CATEGORY_MAP, _IFC_CLASS_TO_CATEGORY
    _REVIT_CATEGORY_MAP = _load_map_file("mapping_revit.json", {})
    _IFC_CLASS_TO_CATEGORY = _load_map_file("mapping_ifc_class.json", {})
    logger.info(
        "Classification maps reloaded: %d Revit entries, %d IFC class entries",
        len(_REVIT_CATEGORY_MAP), len(_IFC_CLASS_TO_CATEGORY),
    )


reload_classification_maps()


def _lookup_by_type(speckle_type: str) -> dict | None:
    """
    Return mapping entry for a speckle_type via:
      1. Exact match
      2. Sub-type after ':' — handles Tekla/Revit v3 compound types like
         'Objects.Data.DataObject:Objects.BuiltElements.Tekla.TeklaBeam'
      3. Longest prefix match
    """
    entry = _MAPPING.get(speckle_type)
    if entry:
        return entry

    # v3 compound type: check the sub-type after the colon
    if ":" in speckle_type:
        sub = speckle_type.split(":", 1)[1]
        entry = _MAPPING.get(sub)
        if entry:
            return entry
        # Also try prefix match on sub-type
        best = ""
        for key in _MAPPING:
            if sub.startswith(key) and len(key) > len(best):
                best = key
        if best:
            return _MAPPING[best]

    # Prefix match on full type
    best_key = ""
    for key in _MAPPING:
        if speckle_type.startswith(key) and len(key) > len(best_key):
            best_key = key
    return _MAPPING[best_key] if best_key else None


def _word_in(token: str, text: str, prefix: bool = False) -> bool:
    """Word-boundary-aware containment check — avoids false positives like
    'wall' matching inside 'wallpaper' or 'duct' matching inside 'conductivity',
    while still matching regular plurals ('walls', 'footings').
    prefix=True only requires a left boundary (e.g. 'reinforc' is a deliberate
    stem meant to match 'reinforcing'/'reinforcement'/'reinforced')."""
    pattern = rf'\b{re.escape(token)}' if prefix else rf'\b{re.escape(token)}s?\b'
    return re.search(pattern, text) is not None


def _heuristic(speckle_type: str) -> dict:
    """Last-resort classification from type string tokens."""
    t = speckle_type.lower()
    if _word_in("wall", t):                                  return {"ifc_class": "IfcWall",         "category": "Walls"}
    if _word_in("slab", t) or _word_in("floor", t):          return {"ifc_class": "IfcSlab",         "category": "Floors"}
    if _word_in("beam", t):                                  return {"ifc_class": "IfcBeam",         "category": "Structural Framing"}
    if _word_in("column", t):                                return {"ifc_class": "IfcColumn",       "category": "Structural Columns"}
    if _word_in("door", t):                                  return {"ifc_class": "IfcDoor",         "category": "Doors"}
    if _word_in("window", t):                                return {"ifc_class": "IfcWindow",       "category": "Windows"}
    if _word_in("roof", t):                                  return {"ifc_class": "IfcRoof",         "category": "Roofs"}
    if _word_in("stair", t):                                 return {"ifc_class": "IfcStair",        "category": "Stairs"}
    if _word_in("railing", t):                               return {"ifc_class": "IfcRailing",      "category": "Railings"}
    if _word_in("space", t) or _word_in("room", t):          return {"ifc_class": "IfcSpace",        "category": "Rooms"}
    if _word_in("pipe", t):                                  return {"ifc_class": "IfcPipeSegment",  "category": "Piping"}
    if _word_in("duct", t):                                  return {"ifc_class": "IfcDuctSegment",  "category": "Duct Systems"}
    if _word_in("footing", t) or _word_in("foundation", t):  return {"ifc_class": "IfcFooting",      "category": "Structural Foundations"}
    if _word_in("pile", t):                                  return {"ifc_class": "IfcPile",         "category": "Structural Foundations"}
    if _word_in("member", t) or _word_in("brace", t):        return {"ifc_class": "IfcMember",       "category": "Structural Framing"}
    if _word_in("plate", t):                                 return {"ifc_class": "IfcPlate",        "category": "Structural Framing"}
    if _word_in("rebar", t) or _word_in("reinforc", t, prefix=True): return {"ifc_class": "IfcReinforcingBar", "category": "Structural Reinforcement"}
    return _FALLBACK


# Tekla class name suffix (after stripping "Tekla" prefix) → classification.
# Used as a fallback when the full speckle_type isn't in mapping_ifc.json
# (e.g. when SpecklePy v2 receives a v3 compound type and only preserves the base).
_TEKLA_SUFFIX_MAP: dict[str, dict] = {
    "Beam":         {"ifc_class": "IfcBeam",                    "category": "Structural Framing"},
    "PolyBeam":     {"ifc_class": "IfcBeam",                    "category": "Structural Framing"},
    "Column":       {"ifc_class": "IfcColumn",                  "category": "Structural Columns"},
    "ContourPlate": {"ifc_class": "IfcPlate",                   "category": "Structural Framing"},
    "Slab":         {"ifc_class": "IfcSlab",                    "category": "Floors"},
    "Wall":         {"ifc_class": "IfcWall",                    "category": "Walls"},
    "Footing":      {"ifc_class": "IfcFooting",                 "category": "Structural Foundations"},
    "Bolt":         {"ifc_class": "IfcFastener",                "category": "Structural Connections"},
    "Rebar":        {"ifc_class": "IfcReinforcingBar",          "category": "Structural Reinforcement"},
    "Assembly":     {"ifc_class": "IfcElementAssembly",         "category": "Structural Framing"},
    "Grid":         {"ifc_class": "IfcGrid",                    "category": "Grids"},
    "Weld":         {"ifc_class": "IfcFastener",                "category": "Structural Connections"},
    "CustomPart":   {"ifc_class": "IfcBuildingElementProxy",    "category": "Generic Models"},
    # --- Best-effort additions below: based on IFC4X3/Tekla Open API naming
    # conventions, NOT verified against a real Tekla connector export. Spot-check
    # these against an actual Tekla model before relying on them in production. ---
    "Plate":        {"ifc_class": "IfcPlate",                   "category": "Structural Framing"},
    "BoltArray":    {"ifc_class": "IfcMechanicalFastener",      "category": "Structural Connections"},
    "RebarGroup":   {"ifc_class": "IfcReinforcingBar",          "category": "Structural Reinforcement"},
    "RebarMesh":    {"ifc_class": "IfcReinforcingMesh",         "category": "Structural Reinforcement"},
}

_debug_sample: set[str] = set()   # track already-logged type keys, avoid log flood

# Matches common Tekla plate profile strings: PLT500*12, PL500*12, PL500X12, [PL]500*12
_TEKLA_PLATE_RE = re.compile(r'(?:PLT?|\[PL\])(\d+(?:\.\d+)?)[*Xx]', re.IGNORECASE)

# Concrete material patterns: C20/25, C30/37, B25, B35, fc3000, CONCRETE, BETON, etc.
# Does NOT match steel grades (S235, S355, A36) or generic names without concrete cues.
_CONCRETE_MAT_RE = re.compile(
    r'^(C\d|B\d|FC\d|CONCRETE|BETON|NORMAL_CONCRETE|LC\d|LWC)',
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Coarse material-category detection — used to scope material-specific charts
# (e.g. "Steel Profiles") to the right elements regardless of source app.
# Operates on the canonical 'material'/'grade' values, which already
# normalise Revit/Tekla/IFC raw keys, so this single classifier covers all
# sources.
# ---------------------------------------------------------------------------
_STEEL_MAT_RE = re.compile(
    r'(?i)(steel|stahl|stal\b|acier|staal|acciaio|'
    r'\bs\d{3}\s*(jr|j0|j2|k2|m|ml|n|nl|w|h)?\b|'
    r'en\s*10025|astm\s*a\d+|\ba36\b|\ba992\b|\ba572\b|\ba500\b)'
)
# Bare EN 338 timber strength classes (C24, D30, ...) are intentionally NOT
# matched here — they're indistinguishable from a bare concrete grade like
# "C25" without more context, and concrete is checked first below.
_TIMBER_MAT_RE = re.compile(
    r'(?i)(timber|wood|holz|glulam|brettschicht|\bkvh\b|\bbsh\b|\bclt\b|\blvl\b|\bgl\d{2}[ch]?\b)'
)
_ALUMINUM_MAT_RE = re.compile(r'(?i)(alumin(i)?um|\balu\b|en\s*aw-?\d|\b(6060|6063|5754)\b)')
_MASONRY_MAT_RE = re.compile(r'(?i)(brick|masonry|block(work)?|mauerwerk|ziegel|\bcmu\b|stone(work)?)')
_GLASS_MAT_RE = re.compile(r'(?i)(glass|glas\b)')


def classify_material_category(value: str | None) -> str | None:
    """
    Classify a material/grade string into a coarse category: steel, concrete,
    timber, aluminum, masonry, glass, or other. Returns None for empty input.

    Order matters — steel and concrete patterns are checked first since they
    are the most specific (EN steel/concrete grade codes).
    """
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    if _STEEL_MAT_RE.search(v):
        return "steel"
    if _CONCRETE_MAT_RE.match(v.upper()) or ("/" in v and re.match(r'(?i)c\d', v)):
        return "concrete"
    if _TIMBER_MAT_RE.search(v):
        return "timber"
    if _ALUMINUM_MAT_RE.search(v):
        return "aluminum"
    if _MASONRY_MAT_RE.search(v):
        return "masonry"
    if _GLASS_MAT_RE.search(v):
        return "glass"
    return "other"


# ---------------------------------------------------------------------------
# Steel section family detection — used for the "Section Classes" chart,
# which groups steel profiles (HEA200, IPE300, RHS100x50x5, ...) by their
# cross-section family regardless of the exact size designation.
# ---------------------------------------------------------------------------
_SECTION_PREFIX_MAP = {
    # I/H beams and columns (European, American, British)
    "HEA": "I / H Beams", "HEB": "I / H Beams", "HEM": "I / H Beams",
    "HD": "I / H Beams", "HL": "I / H Beams", "HP": "I / H Beams",
    "IPE": "I / H Beams", "IPN": "I / H Beams",
    "W": "I / H Beams", "S": "I / H Beams",
    "UB": "I / H Beams", "UC": "I / H Beams", "UBP": "I / H Beams",
    # Channels
    "UPN": "Channels (U/C)", "UPE": "Channels (U/C)", "UAP": "Channels (U/C)",
    "U": "Channels (U/C)", "C": "Channels (U/C)", "MC": "Channels (U/C)",
    "PFC": "Channels (U/C)",
    # Angles
    "L": "Angles (L)",
    # Hollow sections
    "RHS": "Rectangular/Square Hollow (RHS/SHS)",
    "SHS": "Rectangular/Square Hollow (RHS/SHS)",
    "HSS": "Rectangular/Square Hollow (RHS/SHS)",
    "CHS": "Circular Hollow (CHS)", "PIPE": "Circular Hollow (CHS)",
    "ROR": "Circular Hollow (CHS)",
    # Tees
    "T": "Tees (T)", "WT": "Tees (T)", "ST": "Tees (T)", "MT": "Tees (T)",
    # Plates
    "PL": "Plates", "PLT": "Plates",
}

_SECTION_PREFIX_RE = re.compile(r'^[\[\(]?\s*([A-Z]+)')


def classify_section_family(profile_name: str | None) -> str | None:
    """
    Classify a profile/section name into a coarse cross-section family
    (e.g. "HEA200" → "I / H Beams", "RHS100x50x5" → "Rectangular/Square
    Hollow (RHS/SHS)"). Returns "Other Sections" if the prefix isn't
    recognised, or None for empty input.

    Best-effort: profile naming conventions vary widely between catalogues,
    so this groups by the common family prefix rather than parsing exact
    dimensions.
    """
    if not profile_name:
        return None
    p = profile_name.strip().upper()
    if not p:
        return None
    if "PLATE" in p or _TEKLA_PLATE_RE.match(p):
        return "Plates"
    m = _SECTION_PREFIX_RE.match(p)
    if not m:
        return "Other Sections"
    prefix = m.group(1)
    family = _SECTION_PREFIX_MAP.get(prefix)
    if family and re.search(r'\d', p):
        return family
    return "Other Sections"


# Matches a known profile prefix (same list as _SECTION_PREFIX_MAP) as a
# distinct token within a larger string — e.g. "HEA 400" or "HEA400" inside
# "Tragwerksstützen - HEA 400", or "HEA200" inside Revit's own "Family:Type"
# convention "M_HEA-Column:HEA200" — rather than requiring the whole string
# to be just the profile designation the way classify_section_family does.
# Anchored on: a boundary before the prefix (start/whitespace/hyphen/
# underscore/slash/comma/colon) and a boundary after the size number, so
# single-letter prefixes (L, C, T, U, W, S) can't match a stray capital
# letter followed by digits elsewhere in an unrelated name. No IGNORECASE —
# real-world profile callouts are conventionally uppercase, and matching
# lowercase would meaningfully raise the false-positive rate for almost no
# practical benefit.
_PROFILE_IN_TEXT_RE = re.compile(
    r'(?:^|[\s\-_/,:])(' + '|'.join(re.escape(p) for p in sorted(_SECTION_PREFIX_MAP, key=len, reverse=True)) + r')'
    r'\s?(\d{2,4}(?:\s?[xX×]\s?\d{1,4}){0,2}(?:\.\d+)?)'
    r'(?=$|[\s\-_/,.):])'
)


def extract_profile_from_name(name: str | None) -> str | None:
    """
    Best-effort fallback: pull a steel profile designation (e.g. "HEA400")
    out of an element's own name/type string, for sources — chiefly Revit
    exports with no dedicated profile/section parameter at all — where the
    profile only appears embedded in a compound name like "Tragwerksstützen
    - HEA 400". Returns the matched prefix+size with the separating space
    (if any) removed, for consistent grouping regardless of source
    formatting. Returns None if no known profile prefix is found.
    """
    if not name:
        return None
    m = _PROFILE_IN_TEXT_RE.search(name)
    if not m:
        return None
    return m.group(1) + m.group(2).replace(" ", "")


def normalize_profile_label(value: str | None) -> str | None:
    """
    Collapse whitespace between a known profile prefix and its size number
    ("HEA 400" -> "HEA400") so the *same* physical profile doesn't fragment
    into separate "Steel Profiles" chart bars just because different sources
    (or a real Type Name/Section parameter vs. extract_profile_from_name's
    own name-parsing fallback) formatted it differently. Values with no
    recognized prefix are returned unchanged (still merged if identical, but
    not otherwise altered) — this only fixes known profile-format variance,
    it doesn't invent structure that isn't there.
    """
    if not value:
        return value
    stripped = value.strip()
    m = _PROFILE_IN_TEXT_RE.search(stripped)
    if not m or m.span() != (0, len(stripped)):
        # Only collapse when the *entire* (trimmed) value is the profile
        # token itself (the common case for a real Type Name/Section/profile
        # parameter) — don't rewrite part of a longer compound string here,
        # that's what extract_profile_from_name is for.
        return value
    return m.group(1) + m.group(2).replace(" ", "")

# IFC export attribute names that Tekla / the connector may write into obj.properties
_TEKLA_IFC_PROP_KEYS = (
    "IfcExportAs", "ifc_export_as", "IFC_EXPORT_TYPE",
    "IFC2x3_CLASS", "IFC4_CLASS", "ifcType", "ifc_class",
)


def _tekla_profile_height(profile: str) -> float | None:
    """Extract H (height) dimension from a Tekla plate profile string. Returns model units."""
    m = _TEKLA_PLATE_RE.match(profile.strip())
    return float(m.group(1)) if m else None


def _tekla_member_length(obj: "Base") -> float | None:
    """Euclidean distance between obj.startPoint and obj.endPoint."""
    sp = getattr(obj, "startPoint", None)
    ep = getattr(obj, "endPoint", None)
    if sp is None or ep is None:
        return None
    try:
        dx = ep.x - sp.x
        dy = ep.y - sp.y
        dz = ep.z - sp.z
        return math.sqrt(dx * dx + dy * dy + dz * dz)
    except Exception:
        return None


def _tekla_material_is_concrete(obj: "Base") -> bool:
    """Return True if obj.material suggests concrete (vs. steel or unknown)."""
    material = (getattr(obj, "material", None) or "").strip()
    if not material:
        return False
    m = material.upper()
    if _CONCRETE_MAT_RE.match(m):
        return True
    # EN-format concrete grades always contain "/" (C30/37, C45/55, …)
    if "/" in m and re.match(r'C\d', m):
        return True
    return False


def _tekla_ifc_class_from_props(obj: "Base") -> str | None:
    """
    Return an explicit IFC class set in Tekla's user-defined attributes / properties.
    These take highest priority — the user configured them intentionally.
    """
    props = getattr(obj, "properties", None)
    if not isinstance(props, dict):
        return None
    for key in _TEKLA_IFC_PROP_KEYS:
        val = props.get(key)
        if val and isinstance(val, str):
            val = val.strip()
            if val.startswith("Ifc"):
                return val
    return None


_FOOTING_NAME_KEYS = ("FOOTING", "FOUNDATION", "PAD", "PILE_CAP", "PILE CAP", "RAFT")


def _tekla_name_is_footing(name: str) -> bool:
    n = name.upper()
    return any(k in n for k in _FOOTING_NAME_KEYS)


_TEKLA_WALL_NAME_KEYS = ("WALL", "PANEL")


def _tekla_beam_is_wall(obj: "Base") -> bool:
    """
    True when a TSM Beam/PolyBeam/ContourPlate should be reclassified as a wall.
    1. obj.name contains "WALL" or "PANEL" — Tekla users commonly model precast/
       cast-in-place wall panels as PolyBeam or ContourPlate parts (there's no
       dedicated wall class in TSM's own part hierarchy the way Revit has a
       Wall category), named "PANEL" rather than "WALL" — confirmed against a
       real model (branch literally named "walls and floors") where every
       such element fell into "Structural Framing" instead of "Walls" because
       only "WALL" was matched, never "PANEL".
    2. profile height > 0.5 * member length (plate-wall heuristic)
    """
    obj_name = (getattr(obj, "name", None) or "").upper()
    if any(k in obj_name for k in _TEKLA_WALL_NAME_KEYS):
        return True
    profile_h = _tekla_profile_height(getattr(obj, "profile", None) or "")
    if profile_h is not None:
        length = _tekla_member_length(obj)
        if length and length > 0 and profile_h > 0.5 * length:
            return True
    return False


def _lookup_revit_cat(cat: str) -> dict | None:
    """Case-aware lookup of a Revit category string in _REVIT_CATEGORY_MAP."""
    entry = _REVIT_CATEGORY_MAP.get(cat)
    if entry:
        return entry
    lower = cat.lower()
    for k, v in _REVIT_CATEGORY_MAP.items():
        if k.lower() == lower:
            return v
    return None


def _navisworks_revit_category(obj: "Base") -> dict | None:
    """
    Read the Revit category embedded by the Navisworks connector when
    'mappingToRevitCategories' was enabled.  The connector writes:
      obj.properties["LcRevitData_Element"]["LcRevitPropertyElementCategory"] = "Walls"
    The value is a human-readable Revit category display name that maps
    directly into _REVIT_CATEGORY_MAP.
    """
    props = getattr(obj, "properties", None)
    if not isinstance(props, dict):
        return None
    revit_group = props.get("LcRevitData_Element")
    if not isinstance(revit_group, dict):
        return None
    cat_val = revit_group.get("LcRevitPropertyElementCategory")
    if not cat_val or not isinstance(cat_val, str):
        return None
    return _lookup_revit_cat(cat_val.strip())


def _user_props_type_hint(obj: "Base") -> dict | None:
    """
    Check user-supplied type hints written directly on the object or in its
    properties dict.  Covers Blender custom properties and Rhino user strings
    (both are flattened onto the object or into obj.properties).
    Keys checked: ifc_class/IfcType variants → direct IFC class;
                  category/type variants → _REVIT_CATEGORY_MAP lookup.
    """
    _IFC_KEYS = ("ifc_class", "IfcClass", "IFC_CLASS", "ifc_type", "IfcType", "IFC_TYPE")
    _CAT_KEYS = ("category", "Category", "CATEGORY", "type", "Type", "TYPE")

    for source in (obj, getattr(obj, "properties", None)):
        if source is None:
            continue
        bag = source if isinstance(source, dict) else getattr(source, "__dict__", {})
        # Explicit IFC class takes highest priority
        for key in _IFC_KEYS:
            val = bag.get(key)
            if val and isinstance(val, str) and val.strip().startswith("Ifc"):
                ifc_cls = val.strip()
                return {"ifc_class": ifc_cls, "category": _IFC_CLASS_TO_CATEGORY.get(ifc_cls, "Generic Models")}
        # Revit-style category name
        for key in _CAT_KEYS:
            val = bag.get(key)
            if val and isinstance(val, str):
                entry = _lookup_revit_cat(val.strip())
                if entry:
                    return entry
    return None


def _category_from_params(obj: "Base") -> str | None:
    """Extract category string from obj.parameters / .properties bag."""
    for attr in ("parameters", "properties", "typeParameters"):
        bag = getattr(obj, attr, None)
        if bag is None:
            continue
        if isinstance(bag, dict):
            for k in ("category", "Category", "CATEGORY", "CLASS", "TYPENAME"):
                v = bag.get(k)
                if v:
                    return str(v).strip()
        elif hasattr(bag, "__dict__"):
            raw = getattr(bag, "__dict__", {})
            for k in ("category", "Category", "CATEGORY"):
                v = raw.get(k)
                if v:
                    return str(getattr(v, "value", v)).strip()
    return None


def _log_generic_fallthrough(speckle_type: str, obj: "Base | None", category_hint: str, source: str = "") -> None:
    debug_key = f"type:{speckle_type}"
    if debug_key not in _debug_sample:
        _debug_sample.add(debug_key)
        raw_cat = getattr(obj, "category", None) if obj is not None else None
        obj_keys = sorted(obj.__dict__.keys())[:20] if obj is not None else []
        logger.info(
            "classify → Generic  source=%r  type=%s  obj.category=%r  hint=%r  keys=%s",
            source, speckle_type, raw_cat, category_hint, obj_keys,
        )


def classify_element(
    speckle_type: str,
    obj: "Base | None" = None,
    category_hint: str = "",
    source: str = "",
) -> dict:
    """
    Return {ifc_class, category} using source-aware classification.

    source: "Revit" | "Tekla" | "IFC" | "Navisworks" | "Blender" | "Rhino" | "Grasshopper" | "Generic" | "" (auto-detect from speckle_type)

    Tekla path            — obj.type is the TSM class name ("Beam", "ContourPlate", …).
                            category_hint is the Collection name which is also the TSM class name.
    Revit path            — category_hint is the Revit category Collection name (v3 connector).
                            obj.category holds the Revit category string on older connectors.
    IFC path              — obj.type starts with "Ifc"; speckle_type maps via mapping_ifc.json.
    Navisworks path       — reads LcRevitData_Element/LcRevitPropertyElementCategory from
                            obj.properties (set when 'mappingToRevitCategories' was enabled),
                            then falls back to category_hint and name-based heuristics.
    Blender path          — no native type system; checks user-defined custom properties for
                            ifc_class/category hints, then collection name, then obj.name keywords.
    Rhino/Grasshopper path — speckle_type is geometry (Objects.Geometry.*); classification uses
                            mapping_ifc.json for any BuiltElements types, then Rhino user strings
                            (obj attributes), then layer name (category_hint), then obj.name keywords.
    Generic               — fallback signal chain when source is unknown.
    """
    # ── Auto-detect source from speckle_type when caller didn't supply it ──
    if not source:
        if "TeklaObject" in speckle_type or (
            "Tekla" in speckle_type and "Objects.BuiltElements.Tekla" in speckle_type
        ):
            source = "Tekla"

    # ══════════════════════════════════════════════════════════════════════
    # TEKLA
    # Actual wire type: 'Objects.Data.DataObject:Objects.Data.TeklaObject'
    # obj.type = TSM class name; category_hint = Collection name (same value)
    # ══════════════════════════════════════════════════════════════════════
    if source == "Tekla" or "TeklaObject" in speckle_type:
        tekla_type: str | None = None
        if obj is not None:
            tekla_type = getattr(obj, "type", None)
            if not tekla_type:
                try:
                    tekla_type = obj["type"]
                except Exception:
                    pass

        debug_key = f"tekla:{tekla_type}:{category_hint}"
        if debug_key not in _debug_sample:
            _debug_sample.add(debug_key)
            try:
                all_keys = sorted(k for k in obj.__dict__.keys() if not k.startswith("__"))[:20] if obj else []
            except Exception:
                all_keys = []
            logger.info(
                "classify[Tekla]: obj.type=%r  hint=%r  name=%r  material=%r  keys=%s",
                tekla_type, category_hint,
                getattr(obj, "name", None) if obj else None,
                getattr(obj, "material", None) if obj else None,
                all_keys,
            )

        # 0. Explicit IFC type in obj.properties — set by the user in Tekla, highest priority
        if obj is not None:
            ifc_cls = _tekla_ifc_class_from_props(obj)
            if ifc_cls:
                cat = _IFC_CLASS_TO_CATEGORY.get(ifc_cls, "Generic Models")
                return {"ifc_class": ifc_cls, "category": cat}

        # 1. obj.type (TSM class name: "Beam", "Column", "ContourPlate", …)
        if tekla_type and isinstance(tekla_type, str):
            entry = _lookup_revit_cat(tekla_type)
            if entry:
                if entry.get("category") == "Structural Framing" and obj is not None:
                    obj_name = (getattr(obj, "name", None) or "").upper()
                    # TSM.Column inherits TSM.Beam — obj.type is "Beam" for both
                    if "COLUMN" in obj_name:
                        return {"ifc_class": "IfcColumn", "category": "Structural Columns"}
                    # Foundation beams and pad footings named explicitly
                    if _tekla_name_is_footing(obj_name):
                        return {"ifc_class": "IfcFooting", "category": "Structural Foundations"}
                    # Beam with wall geometry (name or profile-height heuristic)
                    if _tekla_beam_is_wall(obj):
                        return {"ifc_class": "IfcWall", "category": "Walls"}
                    # ContourPlate with concrete material: footing name → footing, else → floor slab
                    if tekla_type == "ContourPlate" and _tekla_material_is_concrete(obj):
                        if _tekla_name_is_footing(obj_name):
                            return {"ifc_class": "IfcFooting", "category": "Structural Foundations"}
                        return {"ifc_class": "IfcSlab", "category": "Floors"}
                return entry

        # 2. category_hint (Collection name = TSM class name, e.g. "Beam", "Grid")
        if category_hint:
            entry = _lookup_revit_cat(category_hint)
            if entry:
                return entry

        # 3. speckle_type suffix for named Tekla types (TeklaBeam → Beam)
        last_component = speckle_type.split(".")[-1]
        if last_component.startswith("Tekla"):
            t_entry = _TEKLA_SUFFIX_MAP.get(last_component[5:])
            if t_entry:
                return t_entry

        # 4. mapping_ifc.json
        entry = _lookup_by_type(speckle_type)
        if entry:
            return entry

        # 5. heuristic on TSM class name or speckle_type
        _log_generic_fallthrough(speckle_type, obj, category_hint, source="Tekla")
        return _heuristic(tekla_type or speckle_type)

    # ══════════════════════════════════════════════════════════════════════
    # REVIT
    # v3 connector: category_hint = Revit category Collection name.
    # Older connectors: obj.category attribute.
    # ══════════════════════════════════════════════════════════════════════
    if source == "Revit":
        # 1. category_hint — most reliable for Revit v3
        if category_hint:
            entry = _lookup_revit_cat(category_hint)
            if entry:
                return entry

        # 2. speckle_type mapping (precise Revit types: RevitWall, RevitBeam, …)
        entry = _lookup_by_type(speckle_type)
        if entry and entry.get("category") != "Generic Models":
            return entry

        # 3. obj.category attribute (older connectors write this directly)
        if obj is not None:
            raw_cat = getattr(obj, "category", None)
            if raw_cat is not None and not isinstance(raw_cat, str):
                raw_cat = str(getattr(raw_cat, "value", raw_cat))
            if raw_cat and isinstance(raw_cat, str):
                cat_entry = _lookup_revit_cat(raw_cat.strip())
                if cat_entry:
                    return cat_entry

        # 4. parameters bag
        if obj is not None:
            obj_cat = _category_from_params(obj)
            if obj_cat:
                cat_entry = _lookup_revit_cat(obj_cat)
                if cat_entry:
                    return cat_entry

        # fallthrough
        _log_generic_fallthrough(speckle_type, obj, category_hint, source="Revit")
        return entry or _heuristic(speckle_type)

    # ══════════════════════════════════════════════════════════════════════
    # IFC
    # speckle_type maps directly via mapping_ifc.json; obj.type = IFC class.
    # ══════════════════════════════════════════════════════════════════════
    if source == "IFC":
        # 1. speckle_type mapping (has IfcXxx → category entries)
        entry = _lookup_by_type(speckle_type)
        if entry and entry.get("category") != "Generic Models":
            return entry

        # 2. obj.type = IFC class name
        if obj is not None:
            raw_type = getattr(obj, "type", None) or getattr(obj, "ifcType", None)
            if raw_type and isinstance(raw_type, str) and raw_type.startswith("Ifc"):
                cat = _IFC_CLASS_TO_CATEGORY.get(raw_type, "Generic Models")
                return {"ifc_class": raw_type, "category": cat}

        _log_generic_fallthrough(speckle_type, obj, category_hint, source="IFC")
        return entry or _heuristic(speckle_type)

    # ══════════════════════════════════════════════════════════════════════
    # NAVISWORKS
    # NavisworksObject has displayValue + properties (nested dict).
    # When the connector was sent with mappingToRevitCategories=true, the
    # Revit category lives in properties["LcRevitData_Element"]
    # ["LcRevitPropertyElementCategory"] as a plain display name like "Walls".
    # ══════════════════════════════════════════════════════════════════════
    if source == "Navisworks":
        # 1. Embedded Revit category (highest signal — explicit user mapping)
        if obj is not None:
            entry = _navisworks_revit_category(obj)
            if entry:
                return entry

        # 2. category_hint — Collection name from the hierarchy builder
        if category_hint:
            entry = _lookup_revit_cat(category_hint)
            if entry:
                return entry

        # 3. obj.name keyword heuristic — Navisworks preserves original element names
        if obj is not None:
            name = (getattr(obj, "name", None) or "").lower()
            if name:
                result = _heuristic(name)
                if result != _FALLBACK:
                    return result

        # 4. speckle_type heuristic
        _log_generic_fallthrough(speckle_type, obj, category_hint, source="Navisworks")
        return _heuristic(speckle_type)

    # ══════════════════════════════════════════════════════════════════════
    # BLENDER
    # No native type system — objects are generic Base with a name and an
    # optional custom-properties dict.  Users can annotate objects in Blender
    # with custom properties like {"ifc_class": "IfcWall"} or
    # {"category": "Walls"} before sending.
    # Blender Collections are used as the primary organisational layer;
    # their names land in category_hint.
    # ══════════════════════════════════════════════════════════════════════
    if source == "Blender":
        # 1. User-defined custom properties — explicit intent, highest signal
        if obj is not None:
            entry = _user_props_type_hint(obj)
            if entry:
                return entry

        # 2. Collection name (category_hint) — users organise by discipline
        if category_hint:
            entry = _lookup_revit_cat(category_hint)
            if entry:
                return entry
            result = _heuristic(category_hint.lower())
            if result != _FALLBACK:
                return result

        # 3. Object name keywords — Blender users often include type in names
        if obj is not None:
            name = (getattr(obj, "name", None) or "").lower()
            if name:
                result = _heuristic(name)
                if result != _FALLBACK:
                    return result

        _log_generic_fallthrough(speckle_type, obj, category_hint, source="Blender")
        return _FALLBACK

    # ══════════════════════════════════════════════════════════════════════
    # RHINO / GRASSHOPPER
    # Grasshopper shares the Rhino converter — both produce the same types.
    # speckle_type is usually a pure geometry type (Objects.Geometry.Mesh,
    # Objects.Geometry.Brep, etc.) with no semantic meaning, unless the user
    # explicitly placed a BuiltElements object (Objects.BuiltElements.Wall …).
    # The Rhino layer hierarchy lands in category_hint; Rhino user strings
    # are flattened onto the object's own attributes (no nested properties key).
    # ══════════════════════════════════════════════════════════════════════
    if source in ("Rhino", "Grasshopper"):
        # 1. BuiltElements types — user explicitly chose a semantic type
        entry = _lookup_by_type(speckle_type)
        if entry and entry.get("category") != "Generic Models":
            return entry

        # 2. Rhino user strings / Grasshopper attributes on the object
        if obj is not None:
            hint = _user_props_type_hint(obj)
            if hint:
                return hint

        # 3. Layer name (category_hint) — primary organisational signal in Rhino
        if category_hint:
            layer = category_hint.strip()
            cat_entry = _lookup_revit_cat(layer)
            if cat_entry:
                return cat_entry
            result = _heuristic(layer.lower())
            if result != _FALLBACK:
                return result

        # 4. Object name keyword heuristic
        if obj is not None:
            name = (getattr(obj, "name", None) or "").lower()
            if name:
                result = _heuristic(name)
                if result != _FALLBACK:
                    return result

        _log_generic_fallthrough(speckle_type, obj, category_hint, source=source)
        return _FALLBACK

    # ══════════════════════════════════════════════════════════════════════
    # GENERIC / unknown source — full signal chain
    # ══════════════════════════════════════════════════════════════════════

    # 1. Type-based mapping — skip Generic result, keep for fallback
    entry = _lookup_by_type(speckle_type)
    if entry and entry != _FALLBACK and entry.get("category") != "Generic Models":
        return entry

    # 2. obj.type — IFC class or structural label
    if obj is not None:
        raw_type = getattr(obj, "type", None) or getattr(obj, "ifcType", None)
        if raw_type and isinstance(raw_type, str):
            if raw_type.startswith("Ifc"):
                cat = _IFC_CLASS_TO_CATEGORY.get(raw_type, "Generic Models")
                return {"ifc_class": raw_type, "category": cat}
            else:
                t_entry = _lookup_revit_cat(raw_type)
                if t_entry:
                    return t_entry

    # 3. obj.category
    obj_cat: str | None = None
    if obj is not None:
        raw_cat = getattr(obj, "category", None)
        if raw_cat is not None and not isinstance(raw_cat, str):
            raw_cat = str(getattr(raw_cat, "value", raw_cat))
        if raw_cat and isinstance(raw_cat, str):
            obj_cat = raw_cat.strip()

    # 4. category_hint
    if not obj_cat and category_hint:
        obj_cat = category_hint.strip()

    # 5. parameters bag
    if not obj_cat and obj is not None:
        obj_cat = _category_from_params(obj)

    # Resolve obj_cat
    if obj_cat:
        cat_entry = _lookup_revit_cat(obj_cat)
        if cat_entry:
            return cat_entry
        debug_key = f"cat:{obj_cat}"
        if debug_key not in _debug_sample:
            _debug_sample.add(debug_key)
            logger.info(
                "classify: unrecognised category=%r  hint=%r  speckle_type=%s",
                obj_cat, category_hint, speckle_type,
            )

    _log_generic_fallthrough(speckle_type, obj, category_hint)

    # 6. Type-based Generic entry (better than heuristic)
    if entry:
        return entry

    # 7. Heuristic + fallback
    return _heuristic(speckle_type)



def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, sort_keys=True, default=str)
    return str(v)


def compute_element_hash(obj: Base) -> str:
    """
    SHA-256 fingerprint of an element's stable identity fields.
    Used for change detection between versions.
    Includes: speckle_type, applicationId, category, name, units,
              and a sample of parameter values.
    """
    parts = [
        _safe_str(getattr(obj, "speckle_type", "")),
        _safe_str(getattr(obj, "applicationId", "")),
        _safe_str(getattr(obj, "category", "")),
        _safe_str(getattr(obj, "name", "")),
        _safe_str(getattr(obj, "units", "")),
    ]

    # Include flattened parameters / properties for change sensitivity
    for attr in ("parameters", "properties", "psets"):
        val = getattr(obj, attr, None)
        if isinstance(val, dict):
            parts.append(_safe_str(val))
        elif isinstance(val, Base):
            try:
                parts.append(_safe_str(val.__dict__))
            except Exception:
                pass

    # Use length-prefixed encoding to avoid hash collisions from "|" in values
    fingerprint = "\x00".join(f"{len(p)}:{p}" for p in parts)
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()
