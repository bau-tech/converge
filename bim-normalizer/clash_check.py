"""
Clash detection via the ifcclash package (https://pypi.org/project/ifcclash/
— the same IfcOpenShell-ecosystem tool used by BlenderBIM/Bonsai), which does
real BVH-based mesh-level clash detection through ifcopenshell.geom.tree,
not bounding-box approximation.

ifcclash.Clasher also has an export_bcfxml() that writes results straight to
a .bcfzip, but — like ifctester.reporter.Bcf — it lazily imports the
third-party `bcf-client` package (top-level module `bcf`), which collides
with this app's own local bcf/ package (the BCF-API server routers). Do not
use export_bcfxml() here; clashes are returned as plain JSON and turned into
BCF topics by the frontend through the existing /bcf/2.1 REST API
(bcfClient.createTopic), the same pattern ids_check.py uses.
"""
import logging
import os
import tempfile

import ifcopenshell
import ifcopenshell.util.selector
from ifcclash.ifcclash import Clasher, ClashSettings

logger = logging.getLogger(__name__)


def _with_geometry_count(check_file, selector: str) -> int:
    # A selector matching zero elements, or matching only geometry-less
    # elements (e.g. Tekla "Connection" proxy objects with Representation=None,
    # which exist purely to carry property-set metadata), can't produce a
    # clash and crashes ifcclash instead of just yielding zero results — see
    # the long comment in _run_one_rule below. Count up front so callers can
    # short-circuit instead of calling into ifcclash at all.
    return sum(
        1 for e in ifcopenshell.util.selector.filter_elements(check_file, selector)
        if getattr(e, "Representation", None)
    )


def _resolve_id(check_file, global_id: str, resolve_application_ids: bool) -> str:
    """
    When checking against bim-normalizer's own synthetic IFC export
    (ifc/export.py), every element's Tag is set to its Speckle
    application_id — the same id the frontend's elementByAppIdRef map is
    keyed by (SpeckleViewer.jsx). The IFC GlobalId itself is freshly
    random in that export (ifcopenshell.guid.new()) and can never resolve
    to a scene object, so substitute the Tag here instead. Only called
    with resolve_application_ids=True for the synthetic-export path —
    a real original IFC's Tag has no relation to application_id, so that
    path is left returning the raw GlobalId as before.
    """
    if not resolve_application_ids:
        return global_id
    try:
        tag = check_file.by_guid(global_id).Tag
        return tag.strip() if tag and tag.strip() else global_id
    except Exception:
        return global_id


def _apply_mode_settings(clash_set: dict, mode: str, tolerance: float, clearance: float, allow_touching: bool) -> None:
    if mode == "intersection":
        clash_set["tolerance"] = tolerance
        clash_set["check_all"] = True
    elif mode == "collision":
        clash_set["allow_touching"] = allow_touching
    elif mode == "clearance":
        clash_set["clearance"] = clearance
        clash_set["check_all"] = True
    else:
        raise ValueError(f"Unknown clash mode: {mode!r}")


def _extract_clashes(clash_set: dict, check_file_a, resolve_a: bool, check_file_b, resolve_b: bool) -> list[dict]:
    # check_file_a/check_file_b are the same object for a same-model rule, or
    # two different ifcopenshell files for a cross-model rule — each side's
    # GlobalId is only ever meaningful (and only ever resolved) against the
    # file it actually came from.
    clashes = []
    for c in clash_set.get("clashes", {}).values():
        clash_type = c.get("type")
        clashes.append({
            "a_global_id": _resolve_id(check_file_a, c["a_global_id"], resolve_a),
            "b_global_id": _resolve_id(check_file_b, c["b_global_id"], resolve_b),
            "a_ifc_class": c["a_ifc_class"],
            "b_ifc_class": c["b_ifc_class"],
            "a_name": c["a_name"],
            "b_name": c["b_name"],
            "type": getattr(clash_type, "name", str(clash_type)),
            "p1": list(c["p1"]),
            "p2": list(c["p2"]),
            "distance": c["distance"],
        })
    return clashes


def _run_one_rule(check_file, tmp_path: str, rule: dict, resolve_application_ids: bool = False) -> dict:
    """
    Run a single clash rule against an already-open ifcopenshell file backed
    by tmp_path. Returns the same result shape regardless of how many other
    rules are run alongside it — each rule gets its own fresh Clasher/BVH
    tree, matching the one-rule-at-a-time behavior this was validated against.
    """
    selector_a = rule["selector_a"]
    selector_b = rule.get("selector_b")
    mode = rule.get("mode", "collision")
    tolerance = rule.get("tolerance", 0.01)
    clearance = rule.get("clearance", 0.1)
    allow_touching = rule.get("allow_touching", True)

    base_result = {
        "name": rule.get("name"),
        "mode": mode,
        "selector_a": selector_a,
        "selector_b": selector_b,
    }

    count_a = _with_geometry_count(check_file, selector_a)
    count_b = count_a if not selector_b or selector_b == selector_a else _with_geometry_count(check_file, selector_b)
    if count_a == 0 or count_b == 0:
        return {**base_result, "count": 0, "clashes": []}

    settings = ClashSettings()
    settings.logger = logger
    clasher = Clasher(settings)

    clash_set = {
        "name": rule.get("name") or "clash",
        "a": [{"file": tmp_path, "mode": "i", "selector": selector_a}],
        "mode": mode,
    }
    if selector_b and selector_b != selector_a:
        clash_set["b"] = [{"file": tmp_path, "mode": "i", "selector": selector_b}]
    _apply_mode_settings(clash_set, mode, tolerance, clearance, allow_touching)

    clasher.clash_sets = [clash_set]
    clasher.clash()

    clashes = _extract_clashes(clash_set, check_file, resolve_application_ids, check_file, resolve_application_ids)
    return {**base_result, "count": len(clashes), "clashes": clashes}


def run_clash_checks(ifc_bytes: bytes, rules: list[dict], resolve_application_ids: bool = False) -> list[dict]:
    """
    Run one or more clash rules against the same IFC model in a single pass —
    the model is written to a temp file and opened with ifcopenshell exactly
    once and shared across every rule, so checking N rules costs one export
    re-read instead of N.

    Each rule is a dict: {name?, selector_a, selector_b?, mode?, tolerance?,
    clearance?, allow_touching?} — see run_clash_check's docstring (below,
    kept for the single-rule case) for what these mean. Returns a list of
    per-rule result dicts in the same order as `rules`, each shaped like
    run_clash_check's old single return value plus a `name` field.

    resolve_application_ids: pass True when ifc_bytes came from
    bim-normalizer's own synthetic export (not a real original IFC) — see
    _resolve_id's docstring.

    Passing the same selector as both A and B in a rule double-inserts every
    matching element into ifcclash's BVH tree (once per group) and silently
    corrupts results — so when selector_b is omitted or equal to selector_a,
    only group "a" is built and the library's own self-clash fallback is used.

    allow_touching defaults to True: empirically, clash_collision_many
    reports distance=0.0 for genuine volumetric overlaps just as often as
    for surfaces merely touching (e.g. two axis-aligned boxes sharing a
    face) — allow_touching=False excludes every distance=0.0 result, which
    in practice means it silently drops real overlaps too, not just
    edge/face contact. True is the only setting that reliably catches
    "these two solids occupy the same space".
    """
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
            f.write(ifc_bytes)
            tmp_path = f.name

        check_file = ifcopenshell.open(tmp_path)
        return [_run_one_rule(check_file, tmp_path, rule, resolve_application_ids) for rule in rules]
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _run_one_cross_rule(
    check_file_a, tmp_path_a: str, check_file_b, tmp_path_b: str, rule: dict,
    resolve_a: bool = False, resolve_b: bool = False,
) -> dict:
    """
    Like _run_one_rule, but group "a" and group "b" always come from two
    different IFC files (different models) instead of the same one — there
    is no same-file self-clash fallback here, since A and B are never the
    same model. selector_b defaults to selector_a when omitted, meaning
    "the same IFC class on both sides" rather than "self-clash".
    """
    selector_a = rule["selector_a"]
    selector_b = rule.get("selector_b") or selector_a
    mode = rule.get("mode", "collision")
    tolerance = rule.get("tolerance", 0.01)
    clearance = rule.get("clearance", 0.1)
    allow_touching = rule.get("allow_touching", True)

    base_result = {
        "name": rule.get("name"),
        "mode": mode,
        "selector_a": selector_a,
        "selector_b": selector_b,
    }

    count_a = _with_geometry_count(check_file_a, selector_a)
    count_b = _with_geometry_count(check_file_b, selector_b)
    if count_a == 0 or count_b == 0:
        return {**base_result, "count": 0, "clashes": []}

    settings = ClashSettings()
    settings.logger = logger
    clasher = Clasher(settings)

    clash_set = {
        "name": rule.get("name") or "clash",
        "a": [{"file": tmp_path_a, "mode": "i", "selector": selector_a}],
        "b": [{"file": tmp_path_b, "mode": "i", "selector": selector_b}],
        "mode": mode,
    }
    _apply_mode_settings(clash_set, mode, tolerance, clearance, allow_touching)

    clasher.clash_sets = [clash_set]
    clasher.clash()

    clashes = _extract_clashes(clash_set, check_file_a, resolve_a, check_file_b, resolve_b)
    return {**base_result, "count": len(clashes), "clashes": clashes}


def run_cross_model_clash_checks(
    ifc_bytes_a: bytes, ifc_bytes_b: bytes, rules: list[dict],
    resolve_a: bool = False, resolve_b: bool = False,
) -> list[dict]:
    """
    Like run_clash_checks, but checks model A's elements against model B's
    elements instead of one model against itself — the standard
    cross-discipline clash workflow (e.g. structure vs architecture). Each
    rule's selector_a is matched within model A and selector_b (or
    selector_a again, if selector_b is omitted) within model B.

    Both files are written to temp files and opened with ifcopenshell once,
    shared across every rule, same as run_clash_checks.

    resolve_a / resolve_b: pass True for whichever side's ifc_bytes came
    from bim-normalizer's own synthetic export rather than a real original
    IFC — see _resolve_id's docstring. The two sides are resolved
    independently since either model can have its own IFC source.
    """
    tmp_path_a = tmp_path_b = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
            f.write(ifc_bytes_a)
            tmp_path_a = f.name
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
            f.write(ifc_bytes_b)
            tmp_path_b = f.name

        check_file_a = ifcopenshell.open(tmp_path_a)
        check_file_b = ifcopenshell.open(tmp_path_b)
        return [
            _run_one_cross_rule(check_file_a, tmp_path_a, check_file_b, tmp_path_b, rule, resolve_a, resolve_b)
            for rule in rules
        ]
    finally:
        for tmp_path in (tmp_path_a, tmp_path_b):
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


def run_clash_check(
    ifc_bytes: bytes,
    selector_a: str,
    selector_b: str | None = None,
    mode: str = "collision",
    tolerance: float = 0.01,
    clearance: float = 0.1,
    allow_touching: bool = True,
    resolve_application_ids: bool = False,
) -> dict:
    """
    Single-rule convenience wrapper around run_clash_checks, kept for callers
    that only ever need one rule (e.g. ad-hoc scripts/tests).

    selector_a / selector_b: ifcopenshell.util.selector query syntax
    (e.g. "IfcColumn", "IfcWall, IfcSlab", ".IfcElement[Name*='Beam']").
    mode: "collision" (overlapping solids — the standard hard-clash check;
    use this for "do these two volumes occupy the same space", since
    "intersection" only fires when mesh *faces* actually cross, not for
    e.g. two axis-aligned boxes overlapping with coplanar faces),
    "intersection" (mesh face crossing within tolerance), or "clearance"
    (minimum-distance violation).
    """
    rule = {
        "selector_a": selector_a,
        "selector_b": selector_b,
        "mode": mode,
        "tolerance": tolerance,
        "clearance": clearance,
        "allow_touching": allow_touching,
    }
    return run_clash_checks(ifc_bytes, [rule], resolve_application_ids)[0]
