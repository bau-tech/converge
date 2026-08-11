"""
Shared IFC relationship-graph walking logic. IFC_GRAPH_REL_TYPES and
build_ifc_graph_edges were extracted from converge_mcp.py's ifc_dependency_graph
tool so the relationship-type/attribute-name table isn't duplicated.
extract_relationship_pairs and resolve_relationship_element_ids are new,
reusing that same table for bim-normalizer's own ingest-time extraction into
bim_relationships (see routers/ifc_export.py's extract_ifc_relationships and
db/insert.py's insert_ifc_relationships).
"""

# Relationship types walked when building a connectivity graph from a loaded
# IFC file, each as (ifc_class, relating_attr, related_attr, relating_role_label,
# related_role_label). related_attr may hold a single entity or a list — both
# are handled uniformly. Every relationship becomes two labeled directed edges
# (relating->related and related->relating) so a plain BFS can walk the whole
# graph without needing separate "upstream"/"downstream" logic per relationship
# type — the label on each edge already says which role the neighbor plays.
IFC_GRAPH_REL_TYPES = [
    ("IfcRelAggregates", "RelatingObject", "RelatedObjects", "has part", "is part of"),
    ("IfcRelNests", "RelatingObject", "RelatedObjects", "nests", "is nested in"),
    ("IfcRelContainedInSpatialStructure", "RelatingStructure", "RelatedElements", "contains", "is contained in"),
    ("IfcRelConnectsElements", "RelatingElement", "RelatedElement", "connects to", "connects to"),
    ("IfcRelVoidsElement", "RelatingBuildingElement", "RelatedOpeningElement", "has opening", "voids"),
    ("IfcRelFillsElement", "RelatingOpeningElement", "RelatedBuildingElement", "is filled by", "fills"),
]


def build_ifc_graph_edges(m: "ifcopenshell.file") -> dict:
    """One pass over the loaded model building an undirected-for-traversal
    adjacency map keyed by entity STEP id: {step_id: [(other_step_id, label), ...]}."""
    edges: dict = {}
    for ifc_class, relating_attr, related_attr, relating_label, related_label in IFC_GRAPH_REL_TYPES:
        for rel in m.by_type(ifc_class):
            relating = getattr(rel, relating_attr, None)
            related = getattr(rel, related_attr, None)
            if relating is None or related is None or not hasattr(relating, "id"):
                continue
            related_list = related if isinstance(related, (list, tuple)) else [related]
            for r in related_list:
                if not hasattr(r, "id"):
                    continue
                edges.setdefault(relating.id(), []).append((r.id(), relating_label))
                edges.setdefault(r.id(), []).append((relating.id(), related_label))
    return edges


# ── Ingest-time extraction into bim_relationships ───────────────────────────
#
# bim_relationships stores ONE directed row per relationship (element_id ->
# related_id, resolved to both directions at query time — see db/insert.py's
# build_relationships and db/query.py's get_element_relationships), unlike
# build_ifc_graph_edges above which deliberately duplicates each relationship
# into both directions for its own BFS-walking use case. So this reuses
# IFC_GRAPH_REL_TYPES (the relationship-type/attribute-name table) but not
# build_ifc_graph_edges itself — a relation_type per IFC class instead of a
# human-readable role label per direction.
_IFC_CLASS_TO_RELATION_TYPE = {
    "IfcRelAggregates": "aggregates",
    "IfcRelNests": "aggregates",  # same "is part of" semantics as Aggregates
    "IfcRelContainedInSpatialStructure": "contained_in",
    "IfcRelConnectsElements": "connects",
    "IfcRelVoidsElement": "voids",
    "IfcRelFillsElement": "fills",
}


def extract_relationship_pairs(m: "ifcopenshell.file") -> list[tuple[int, int, str]]:
    """Walk the model's real IFC relationship entities once, returning
    (relating_step_id, related_step_id, relation_type) — one row per
    relationship instance, not per direction."""
    pairs = []
    for ifc_class, relating_attr, related_attr, _relating_label, _related_label in IFC_GRAPH_REL_TYPES:
        relation_type = _IFC_CLASS_TO_RELATION_TYPE[ifc_class]
        for rel in m.by_type(ifc_class):
            relating = getattr(rel, relating_attr, None)
            related = getattr(rel, related_attr, None)
            if relating is None or related is None or not hasattr(relating, "id"):
                continue
            related_list = related if isinstance(related, (list, tuple)) else [related]
            for r in related_list:
                if not hasattr(r, "id"):
                    continue
                pairs.append((relating.id(), r.id(), relation_type))
    return pairs


def resolve_relationship_element_ids(
    m: "ifcopenshell.file",
    pairs: list[tuple[int, int, str]],
    ifc_source: str,
    app_id_to_element: dict,
    revit_guid_map: dict,
) -> list[tuple[str, str, str]]:
    """Resolve each (relating_step_id, related_step_id, relation_type) triple
    to (element_id, related_element_id, relation_type), dropping pairs where
    either side doesn't resolve to a locally-ingested element (e.g. the
    relationship references a spatial-structure entity whose matching Level
    was never ingested as a bim_elements row) or is a self-loop.

    ifc_source == "synthetic_export": every IfcElement's Tag was set to its
    Speckle application_id by ifc/export.py — direct lookup, no GlobalId
    involved (that export mints fresh random GlobalIds — see
    routers/ifc_export.py's resolve_model_ifc_bytes docstring).
    IfcBuildingStorey (and other IfcSpatialStructureElement subtypes) have no
    Tag attribute at all in the IFC schema — ifc/export.py stashes the
    matching Level's application_id in a "Converge" pset on those instead,
    read back here via ifcopenshell.util.element.get_psets.

    ifc_source == "original_ifc": try revit_guid_map (GlobalId -> Revit
    UniqueId application_id) first, then fall back to using the GlobalId
    directly — the fallback is what resolves IFC-native models, where
    application_id already IS the GlobalId (confirmed during the clash/IDS
    highlighting fix earlier this session).
    """
    def _app_id(step_id: int) -> str | None:
        entity = m.by_id(step_id)
        if ifc_source == "synthetic_export":
            tag = getattr(entity, "Tag", None)
            if tag and str(tag).strip():
                return str(tag).strip()
            import ifcopenshell.util.element as ifc_util
            app_id = (ifc_util.get_psets(entity).get("Converge") or {}).get("application_id")
            return str(app_id).strip() if app_id else None
        guid = getattr(entity, "GlobalId", None)
        if not guid:
            return None
        return revit_guid_map.get(guid) or guid

    resolved = []
    for relating_id, related_id, relation_type in pairs:
        relating_app_id = _app_id(relating_id)
        related_app_id = _app_id(related_id)
        if not relating_app_id or not related_app_id:
            continue
        element_id = app_id_to_element.get(relating_app_id)
        related_element_id = app_id_to_element.get(related_app_id)
        if not element_id or not related_element_id or element_id == related_element_id:
            continue
        resolved.append((element_id, related_element_id, relation_type))
    return resolved


def extract_ifc_relationship_links(
    ifc_bytes: bytes, ifc_source: str, app_id_to_element: dict, revit_guid_map: dict
) -> list[tuple[str, str, str]]:
    """
    Open ifc_bytes, walk its real IFC relationships, and resolve them to
    (element_id, related_element_id, relation_type) tuples ready for
    db/insert.py's insert_ifc_relationships. Module-level (not a nested
    closure) so it's picklable for process_pool.py's run_cpu_bound — see
    routers/ifc_export.py's extract_ifc_relationships, the async orchestrator
    that calls this.

    For ifc_source == "synthetic_export", drops "connects" pairs — confirmed
    (ifc/export.py's own docstring) that bim-normalizer's synthetic exporter
    emits IfcRelConnectsElements as a direct re-encoding of bim_relationships'
    existing parent/room/space rows for that path, not independent connection
    analysis. Keeping them would just duplicate the same fact under two
    relation_types. aggregates/contained_in ARE independently useful even for
    a synthetic export (spatial hierarchy bim_relationships doesn't otherwise
    capture), so those are kept.
    """
    import os
    import tempfile

    import ifcopenshell

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
            f.write(ifc_bytes)
            tmp_path = f.name
        m = ifcopenshell.open(tmp_path)
        pairs = extract_relationship_pairs(m)
        resolved = resolve_relationship_element_ids(m, pairs, ifc_source, app_id_to_element, revit_guid_map)
        if ifc_source == "synthetic_export":
            resolved = [r for r in resolved if r[2] != "connects"]
        return resolved
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
