from specklepy.objects import Base


def get_storey(obj: Base) -> str | None:
    """
    Resolve the storey / level name for an element.

    Source-specific paths:
      Revit   — obj.level (Base with .name, or str)
      Tekla   — obj.properties["PHASE"] or obj.udas["PHASE"]
      IFC     — obj.level (str from IfcBuildingStorey)
      Generic — obj.storey, obj.Level, parameters/properties bag
    """
    # Direct level attribute (Revit, IFC)
    level = getattr(obj, "level", None)
    if level is not None:
        if isinstance(level, str) and level.strip():
            return level.strip()
        if isinstance(level, Base):
            name = getattr(level, "name", None)
            if name:
                return str(name).strip()
        if isinstance(level, dict):
            name = level.get("name") or level.get("Name")
            if name:
                return str(name).strip()

    # obj.storey — some IFC / older connectors
    storey = getattr(obj, "storey", None)
    if storey and isinstance(storey, str) and storey.strip():
        return storey.strip()

    # Tekla: PHASE in properties dict (most reliable storey concept in Tekla)
    props = getattr(obj, "properties", None)
    if isinstance(props, dict):
        for key in ("PHASE", "Phase", "MAIN_PART.PHASE", "BUILDING_STOREY", "Level", "level", "Floor"):
            val = props.get(key)
            if val and isinstance(val, (str, int, float)):
                s = str(val).strip()
                if s and s not in ("0", ""):
                    return s

    # Tekla: PHASE in udas
    udas = getattr(obj, "udas", None)
    if isinstance(udas, dict):
        for key in ("PHASE", "Phase", "BUILDING_STOREY"):
            val = udas.get(key)
            if val and isinstance(val, (str, int, float)):
                s = str(val).strip()
                if s and s not in ("0", ""):
                    return s

    # Revit parameters dict
    params = getattr(obj, "parameters", None)
    if isinstance(params, dict):
        for key in ("Level", "level", "Floor", "Base Level", "Reference Level"):
            val = params.get(key)
            if val is not None:
                if isinstance(val, dict):
                    val = val.get("value", val)
                if val:
                    return str(val).strip()

    # Revit typeParameters (less common for storey, but check anyway)
    type_params = getattr(obj, "typeParameters", None)
    if isinstance(type_params, dict):
        val = type_params.get("Level")
        if val and isinstance(val, dict):
            val = val.get("value")
        if val:
            return str(val).strip()

    return None


def get_application_id(obj: Base) -> str | None:
    """
    Return the stable native-application element identifier.

    Source-specific:
      Revit   — applicationId (UniqueId, format: XXXXXXXX-XXXX-…)
      Tekla   — applicationId or properties["Report.GUID"] / properties["GUID"]
      IFC     — GlobalId (22-char IFC GUID) or globalId
    """
    # Standard Speckle applicationId — set by all connectors
    for attr in ("applicationId", "UniqueId", "GlobalId", "globalId", "guid", "identifier", "Identifier"):
        val = getattr(obj, attr, None)
        if val and isinstance(val, str) and val.strip():
            return val.strip()

    # Tekla: GUID in properties dict
    props = getattr(obj, "properties", None)
    if isinstance(props, dict):
        for key in ("Report.GUID", "GUID", "guid", "applicationId", "GlobalId"):
            val = props.get(key)
            if val and isinstance(val, str) and val.strip():
                return val.strip()

    # Tekla: GUID in udas
    udas = getattr(obj, "udas", None)
    if isinstance(udas, dict):
        for key in ("GUID", "guid", "Report.GUID"):
            val = udas.get(key)
            if val and isinstance(val, str) and val.strip():
                return val.strip()

    return None
