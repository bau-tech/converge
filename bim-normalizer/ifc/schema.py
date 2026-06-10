"""
IFC schema constants, known Pset names, and unit conversion helpers.
"""

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

# Unit conversion factors → always normalise to SI base units
MM_TO_M   = 0.001
CM_TO_M   = 0.01
IN_TO_M   = 0.0254
FT_TO_M   = 0.3048

MM3_TO_M3 = 1e-9
CM3_TO_M3 = 1e-6
IN3_TO_M3 = 1.6387064e-5
FT3_TO_M3 = 0.0283168

MM2_TO_M2 = 1e-6
CM2_TO_M2 = 1e-4
IN2_TO_M2 = 6.4516e-4
FT2_TO_M2 = 0.092903


def length_to_m(value: float, units: str) -> float:
    u = (units or "mm").lower()
    factors = {"mm": MM_TO_M, "cm": CM_TO_M, "m": 1.0, "in": IN_TO_M, "ft": FT_TO_M}
    return value * factors.get(u, MM_TO_M)


def volume_to_m3(value: float, units: str) -> float:
    u = (units or "mm").lower()
    factors = {"mm": MM3_TO_M3, "cm": CM3_TO_M3, "m": 1.0, "in": IN3_TO_M3, "ft": FT3_TO_M3}
    return value * factors.get(u, MM3_TO_M3)


def area_to_m2(value: float, units: str) -> float:
    u = (units or "mm").lower()
    factors = {"mm": MM2_TO_M2, "cm": CM2_TO_M2, "m": 1.0, "in": IN2_TO_M2, "ft": FT2_TO_M2}
    return value * factors.get(u, MM2_TO_M2)
