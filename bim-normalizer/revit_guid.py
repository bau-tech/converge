"""
Reproduces the Revit IFC exporter's default GlobalId derivation from a
Revit Element.UniqueId, so an IFC GlobalId coming from a *real* Revit-
exported IFC file can be matched back to the corresponding Speckle
element.

Why this exists: the Revit connector sets application_id = Element.UniqueId
for every element it sends (confirmed in speckle-sharp-connectors'
RevitRootToSpeckleConverter.cs: `result.applicationId = element.UniqueId`).
When a clash/IDS check runs against a model's *original* IFC file (rather
than bim-normalizer's own synthetic export), that file's GlobalIds come
from Revit's own exporter — which does NOT use UniqueId directly. Revit's
default path (Autodesk's open-source Revit.IFC.Export.Utility.GUIDUtil,
via GUIDUtil.CreateSimpleGUID -> ExportUtils.GetExportId) derives each
element's export GUID by XORing the last 32 bits of the UniqueId's episode
GUID with the element's local id suffix, then compressing that GUID into
the standard 22-character IFC GlobalId string. This is re-derived here so
it can be matched against.

Algorithm cross-verified against two independent sources:
- Autodesk's own open-source GUIDUtil.cs (ConvertToIFCGuid), from
  https://github.com/Autodesk/revit-ifc
- The widely-used community reference implementation at
  https://github.com/hakonhc/IfcGuid (IfcGuid.cs, ToIfcGuid + the
  UniqueId-to-GUID extension method)
Both produce byte-identical output to ifcopenshell.guid.compress() when
fed a standard (non-.NET-byte-order) hex UUID string — confirmed
empirically against 5 random GUIDs, so ifcopenshell's own (already a
dependency here) compression is reused rather than reimplementing it.

Only applies to Revit-sourced application_ids — anything not shaped like
a Revit UniqueId (e.g. Tekla connector output uses a different format)
is left alone; callers just won't get a match for those, same as before
this module existed.
"""
import re
import uuid

import ifcopenshell.guid

_REVIT_UNIQUE_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}-[0-9a-fA-F]{8}$"
)


def revit_unique_id_to_ifc_guid(unique_id: str | None) -> str | None:
    """Returns the IFC GlobalId Revit's own exporter would assign to the
    element with this UniqueId, or None if unique_id isn't in Revit's
    UniqueId format (episode GUID + 8-hex-digit element id suffix)."""
    if not unique_id or not _REVIT_UNIQUE_ID_RE.match(unique_id):
        return None
    episode = unique_id[:36]
    element_id = int(unique_id[37:], 16)
    last_32_bits = int(unique_id[28:36], 16)
    xor = (last_32_bits ^ element_id) & 0xFFFFFFFF
    modified = episode[:28] + format(xor, "08x")
    try:
        guid = uuid.UUID(modified)
    except ValueError:
        return None
    return ifcopenshell.guid.compress(guid.hex)


def build_guid_map(application_ids: list[str]) -> dict[str, str]:
    """Maps computed-IFC-GlobalId -> application_id for every id that looks
    like a Revit UniqueId. Non-Revit application_ids are silently skipped,
    so this is a safe no-op (empty map) for Tekla/other-sourced models."""
    mapping = {}
    for app_id in application_ids:
        ifc_guid = revit_unique_id_to_ifc_guid(app_id)
        if ifc_guid:
            mapping[ifc_guid] = app_id
    return mapping
