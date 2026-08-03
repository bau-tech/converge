"""
IDS (Information Delivery Specification) checking, via the ifctester package
(https://pypi.org/project/ifctester/ — the IDS engine that now ships
separately from core ifcopenshell).

ifctester.reporter also has a Bcf reporter class that writes results
straight to a .bcfzip, but it lazily imports the third-party `bcf-client`
package (top-level module name `bcf`) — which collides with this app's own
local bcf/ package (the BCF-API server routers in bcf_server.py). Do not use
ifctester.reporter.Bcf here; it would resolve to the wrong `bcf` module.
Instead, failures are reported as plain JSON and turned into BCF topics by
the frontend through the existing /bcf/2.1 REST API (bcfClient.createTopic).
"""
import json
import os
import tempfile

import ifcopenshell
from ifctester import ids as ids_module
from ifctester import reporter


class InvalidIdsError(ValueError):
    pass


def validate_ids_xml(content: str) -> None:
    """
    Raise InvalidIdsError if `content` is not a well-formed IDS file.

    Deliberately does not pass validate=True: ifctester's strict XSD pass
    validates the parsed tree with stdlib xml.etree.ElementTree, which does
    not expose per-element namespace-prefix maps the way lxml does — so any
    spec using a <value>/<xs:restriction> facet (enumerations, patterns,
    bounds — i.e. most real-world IDS specs) fails QName resolution for
    base="xs:string" and gets rejected even though it's perfectly valid.
    from_string()'s structural decode (run regardless of validate=True)
    still rejects malformed XML and non-IDS documents.
    """
    try:
        ids_module.from_string(content)
    except Exception as exc:
        # ifctester's IdsXmlValidationError.__str__ is just the generic
        # "...appears to be invalid. See details above." stub — the actual
        # reason (e.g. "Tag 'ids:baseName' expected") only lives on its
        # .xml_error (an xmlschema XMLSchemaValidationError), which is
        # otherwise silently discarded, leaving callers with no way to tell
        # what's actually wrong with the document.
        xml_error = getattr(exc, "xml_error", None)
        reason = getattr(xml_error, "reason", None) if xml_error is not None else None
        path = getattr(xml_error, "path", None) if xml_error is not None else None
        detail = f"{reason} (at {path})" if reason and path else (reason or str(exc))
        raise InvalidIdsError(detail) from exc


def run_ids_check(
    ifc_bytes: bytes, ids_content: str, resolve_application_ids: bool = False,
    revit_guid_map: dict[str, str] | None = None,
) -> dict:
    """
    Validate an in-memory IFC file against an IDS spec and return a
    JSON-serializable report (ifctester.reporter.Json's results dict).

    resolve_application_ids: pass True when ifc_bytes came from
    bim-normalizer's own synthetic export (ifc/export.py), not a real
    original IFC. That export sets every element's Tag to its Speckle
    application_id — the id the frontend's elementByAppIdRef map is keyed
    by (SpeckleViewer.jsx) — while the IFC GlobalId itself is freshly
    random (ifcopenshell.guid.new()) and can never resolve to a scene
    object. ifctester's Json reporter already includes each failed
    entity's Tag alongside its global_id (reporter.py's
    report_failed_entities), so when set, global_id is substituted with
    that Tag so 3D highlighting on click can resolve it. A real original
    IFC's Tag has no relation to application_id, so that path is left
    returning the raw GlobalId as before.

    revit_guid_map: pass the map from routers.ifc_export.build_revit_guid_map()
    when ifc_bytes is a real original IFC from a Revit-published model —
    resolves the Revit exporter's own GlobalIds back to application_id via
    the computed UniqueId<->GlobalId correlation (see revit_guid.py),
    covering the case resolve_application_ids doesn't (a genuine original
    IFC file, not our synthetic export). Mutually exclusive in practice
    with resolve_application_ids (one model is either synthetic-exported
    or original-IFC-checked, never both), but both are tried independently
    so passing both is harmless.
    """
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
            f.write(ifc_bytes)
            tmp_path = f.name
        ifc_file = ifcopenshell.open(tmp_path)
        spec = ids_module.from_string(ids_content)
        spec.validate(ifc_file)
        results = reporter.Json(spec).report()
        if resolve_application_ids:
            for specification in results.get("specifications", []):
                for requirement in specification.get("requirements", []):
                    for entity in requirement.get("failed_entities", []):
                        tag = entity.get("tag")
                        if tag and str(tag).strip():
                            entity["global_id"] = str(tag).strip()
        if revit_guid_map:
            for specification in results.get("specifications", []):
                for requirement in specification.get("requirements", []):
                    for entity in requirement.get("failed_entities", []):
                        mapped = revit_guid_map.get(entity.get("global_id"))
                        if mapped:
                            entity["global_id"] = mapped
        # Json.encode() stringifies anything non-JSON-native (ifcopenshell
        # entity instances in particular) — round-trip through json to get a
        # plain dict back instead of a half-native/half-stringified mix.
        return json.loads(json.dumps(results, default=str))
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
