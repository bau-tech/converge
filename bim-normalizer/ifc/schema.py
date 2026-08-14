"""
IFC schema constants, known Pset names, and unit conversion helpers.
"""
import logging
import math

logger = logging.getLogger(__name__)

# Known Pset names by IFC class (non-exhaustive, extend as needed)
PSET_BY_IFC_CLASS: dict[str, list[str]] = {
    "IfcWall":      ["Pset_WallCommon", "Pset_ConcreteElementGeneral"],
    "IfcSlab":      ["Pset_SlabCommon", "Pset_ConcreteElementGeneral"],
    "IfcBeam":      ["Pset_BeamCommon", "Pset_ConcreteElementGeneral"],
    "IfcColumn":    ["Pset_ColumnCommon", "Pset_ConcreteElementGeneral"],
    "IfcDoor":      ["Pset_DoorCommon"],
    "IfcWindow":    ["Pset_WindowCommon"],
    "IfcRoof":      ["Pset_RoofCommon"],
    "IfcStair":     ["Pset_StairCommon"],
    "IfcSpace":     ["Pset_SpaceCommon"],
    "IfcFooting":   ["Pset_FootingCommon"],
    "IfcPile":      ["Pset_PileCommon"],
    "IfcMember":    ["Pset_MemberCommon"],
}

# All recognised IFC entity names (subset relevant to BIM)
IFC_ENTITIES = {
    "IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn",
    "IfcDoor", "IfcWindow", "IfcRoof", "IfcStair", "IfcRailing", "IfcSpace",
    "IfcMember", "IfcFooting", "IfcPile", "IfcCovering", "IfcCurtainWall",
    "IfcPipeSegment", "IfcDuctSegment", "IfcGeographicElement",
    "IfcBuildingElementProxy", "IfcPropertySingleValue",
}

# Length-unit conversion factors → SI (metres). Recognizes both IFC/Speckle
# abbreviations and full English unit words, so identically-meant units
# labeled differently by different connectors convert identically. This is
# the single source of truth for unit conversion in the normalizer — reused
# by db/insert.py's parameter SI-normalization and by ifc/geometry.py's mesh
# volume/area computation, instead of each maintaining its own (previously
# divergent, abbreviation-only) table.
LENGTH_TO_M = {
    "mm": 0.001, "millimeter": 0.001, "millimeters": 0.001, "millimetre": 0.001, "millimetres": 0.001,
    "cm": 0.01, "centimeter": 0.01, "centimeters": 0.01, "centimetre": 0.01, "centimetres": 0.01,
    "m": 1.0, "meter": 1.0, "meters": 1.0, "metre": 1.0, "metres": 1.0,
    "km": 1000.0, "kilometer": 1000.0, "kilometers": 1000.0,
    "in": 0.0254, "inch": 0.0254, "inches": 0.0254,
    "ft": 0.3048, "foot": 0.3048, "feet": 0.3048,
    "yd": 0.9144, "yard": 0.9144, "yards": 0.9144,
}

MASS_TO_KG = {
    "kg": 1.0, "kilogram": 1.0, "kilograms": 1.0,
    "g": 0.001, "gram": 0.001, "grams": 0.001,
    "t": 1000.0, "tonne": 1000.0, "tonnes": 1000.0, "ton": 1000.0, "tons": 1000.0,
    "lb": 0.45359237, "lbs": 0.45359237, "pound": 0.45359237, "pounds": 0.45359237,
}

# Compound area/volume unit words, mapped to the LENGTH_TO_M key they're
# built from. Connectors commonly report a Volume/Area parameter's OWN unit
# — distinct from (and often finer-grained than) the model's base length
# unit — as a compound word rather than a bare length abbreviation: live
# Speckle payloads observed include Revit's German "Kubikmeter"/"Quadratmeter"
# and Tekla's English "Cubic millimeters"/"Square millimeters". A bare
# length-unit table (LENGTH_TO_M) can't resolve these directly, so db/insert.py's
# per-parameter SI normalization silently dropped every such value — this maps
# the observed spellings to their base length unit so AREA_TO_M2/VOLUME_TO_M3
# below can square/cube LENGTH_TO_M's already-correct factor instead of
# hand-maintaining a second, easy-to-drift set of raw m2/m3 factors.
_AREA_UNIT_WORDS = {
    "m2": "m", "m²": "m", "sqm": "m", "sq m": "m", "square meter": "m", "square meters": "m",
    "square metre": "m", "square metres": "m", "quadratmeter": "m",
    "mm2": "mm", "mm²": "mm", "square millimeter": "mm", "square millimeters": "mm",
    "square millimetre": "mm", "square millimetres": "mm", "quadratmillimeter": "mm",
    "cm2": "cm", "cm²": "cm", "square centimeter": "cm", "square centimeters": "cm",
    "square centimetre": "cm", "square centimetres": "cm", "quadratzentimeter": "cm",
    "ft2": "ft", "sq ft": "ft", "square foot": "ft", "square feet": "ft",
    "in2": "in", "sq in": "in", "square inch": "in", "square inches": "in",
}
_VOLUME_UNIT_WORDS = {
    "m3": "m", "m³": "m", "cbm": "m", "cubic meter": "m", "cubic meters": "m",
    "cubic metre": "m", "cubic metres": "m", "kubikmeter": "m",
    "mm3": "mm", "mm³": "mm", "cubic millimeter": "mm", "cubic millimeters": "mm",
    "cubic millimetre": "mm", "cubic millimetres": "mm", "kubikmillimeter": "mm",
    "cm3": "cm", "cm³": "cm", "cubic centimeter": "cm", "cubic centimeters": "cm",
    "cubic centimetre": "cm", "cubic centimetres": "cm", "kubikzentimeter": "cm",
    "ft3": "ft", "cubic foot": "ft", "cubic feet": "ft",
    "in3": "in", "cubic inch": "in", "cubic inches": "in",
}

AREA_TO_M2   = {word: LENGTH_TO_M[base] ** 2 for word, base in _AREA_UNIT_WORDS.items()}
VOLUME_TO_M3 = {word: LENGTH_TO_M[base] ** 3 for word, base in _VOLUME_UNIT_WORDS.items()}


def length_to_m(value: float, units: str) -> float:
    u = (units or "mm").strip().lower()
    factor = LENGTH_TO_M.get(u)
    if factor is None:
        logger.warning("length_to_m: unrecognized unit %r, assuming mm", units)
        factor = LENGTH_TO_M["mm"]
    return value * factor


def volume_to_m3(value: float, units: str) -> float:
    return value * length_to_m(1.0, units) ** 3


def area_to_m2(value: float, units: str) -> float:
    return value * length_to_m(1.0, units) ** 2


def sanitize_float(v):
    """Return v as a finite float, or None if v is None/NaN/Inf/unparseable.
    Guards against degenerate geometry (e.g. zero-area triangles) producing
    NaN/Inf values that would otherwise break JSON serialization or get
    written into a Postgres FLOAT column."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def sanitize_floats(seq):
    """Apply sanitize_float() to each element of a sequence, or return None."""
    return None if seq is None else [sanitize_float(x) for x in seq]
