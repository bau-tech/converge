import copy
import logging

import requests as _requests
from specklepy.api import operations
from specklepy.objects import Base
from specklepy.transports.server import ServerTransport

from config import settings
from speckle.client import get_client
from speckle.fetch import fetch_commit, fetch_bundle_selection, flatten_elements, _should_skip

logger = logging.getLogger(__name__)

_CONTAINER_FRAGMENTS = ("Collection", "Model", "Folder", "TeklaPhase", "TeklaLayer")

# IFC spatial hierarchy types that act as containers for BIM elements
_IFC_SPATIAL_FRAGMENTS = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey",
                           "IfcSpace", "IfcZone", "IfcSpatialZone", "IfcExternalSpatialElement")


def _is_container(speckle_type: str, has_elements: bool = False) -> bool:
    if any(f in speckle_type for f in _CONTAINER_FRAGMENTS):
        return True
    # IFC spatial containers: recognised by type name AND by having child elements
    if has_elements and any(f in speckle_type for f in _IFC_SPATIAL_FRAGMENTS):
        return True
    return False


def _filter_tree(
    node: Base,
    id_set: set[str],
    depth: int = 0,
    max_depth: int = 50,
    bundle_levels: dict[str, str] | None = None,
    bundle_classification: dict | None = None,
) -> tuple[Base | None, int]:
    """
    Recursively clone the Speckle object tree keeping only the elements
    whose `id` is in *id_set*.

    Container nodes (Collection, Model, Folder, …) are cloned and kept
    only when at least one descendant matches.  Pure-geometry fragments
    (Mesh, Line, RenderMaterial, …) are always dropped.

    bundle_levels/bundle_classification (from fetch_commit's commit_meta,
    non-empty only for a bundle-format source commit — see speckle/fetch.py's
    _fetch_bundle docstring): baked onto each surviving leaf as real "level"/
    "ifcType" attributes before republishing, rather than left for the
    republished (always classic-format) commit to somehow recover on its own
    re-ingest. Without this, filtering a bundle-origin model silently threw
    away the storey/classification enrichment pipeline.normalize's
    ingest_commit recovers on direct ingest — the republished copy has
    is_bundle=False, so it would never see bundle_levels/bundle_classification
    at all on its own later ingest. get_storey()/classify_element() already
    read exactly these attribute names (ifc/spatial.py, ifc/classify.py's IFC
    path), so baking them in requires no changes on the re-ingest side.
    Kept ids are shallow-copied (never mutating the shared original tree,
    which is also reused by create_viewer_bridge/other filter selections) —
    copy.copy is enough since only new top-level attributes are added, no
    nested value (displayValue, properties, …) is modified in place.

    Returns (filtered_node_or_None, matched_leaf_count).
    """
    if depth > max_depth:
        return None, 0

    st = getattr(node, "speckle_type", "") or ""

    if _should_skip(st):
        return None, 0

    children = getattr(node, "elements", None) or []
    if _is_container(st, has_elements=bool(children)):
        kept: list[Base] = []
        total = 0
        for child in children:
            if not isinstance(child, Base):
                continue
            filtered, count = _filter_tree(
                child, id_set, depth + 1, max_depth, bundle_levels, bundle_classification)
            if filtered is not None:
                kept.append(filtered)
                total += count

        if not kept:
            return None, 0

        # Shallow-clone the container preserving identity attributes
        new_node = Base()
        for attr in ("speckle_type", "name", "collectionType", "applicationId",
                     "units", "level"):
            val = getattr(node, attr, None)
            if val is not None:
                new_node[attr] = val
        new_node["elements"] = kept
        return new_node, total

    # Leaf element: keep as-is if selected
    node_id = getattr(node, "id", None)
    if node_id not in id_set:
        return None, 0

    level_override = (bundle_levels or {}).get(str(node_id))
    class_override = (bundle_classification or {}).get(str(node_id))
    ifc_type_override = class_override[0] if class_override else None
    if (level_override and not getattr(node, "level", None)) or (
            ifc_type_override and not getattr(node, "ifcType", None)):
        node = copy.copy(node)
        if level_override and not getattr(node, "level", None):
            node["level"] = level_override
        if ifc_type_override and not getattr(node, "ifcType", None):
            node["ifcType"] = ifc_type_override
    return node, 1


def _gql(srv: str, tok: str, query: str, variables: dict | None = None) -> dict:
    resp = _requests.post(
        f"{srv}/graphql",
        json={"query": query, "variables": variables or {}},
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")
    return body["data"]


def _ensure_branch(
    srv: str, tok: str, stream_id: str, branch_name: str,
    description: str = "Created by bim-normalizer filter-publish",
) -> None:
    """Create branch if it doesn't already exist. Also used by
    routers/models.py's IFC upload endpoint — Speckle's own file-import REST
    endpoint (/api/file/autodetect/{streamId}/{branchName}) 404s with
    BRANCH_NOT_FOUND if the target branch doesn't already exist, unlike
    commitCreate which is fine with an existing branch name only."""
    data = _gql(srv, tok, """
        query($streamId: String!, $branchName: String!) {
            stream(id: $streamId) {
                branch(name: $branchName) { id }
            }
        }
    """, {"streamId": stream_id, "branchName": branch_name})

    if data["stream"]["branch"] is not None:
        return

    _gql(srv, tok, """
        mutation($branch: BranchCreateInput!) {
            branchCreate(branch: $branch)
        }
    """, {"branch": {
        "streamId": stream_id,
        "name": branch_name,
        "description": description,
    }})
    logger.info("Created branch %r on stream %s", branch_name, stream_id)


def _create_commit(
    srv: str, tok: str,
    stream_id: str, object_id: str,
    branch_name: str, message: str,
    source_application: str = "bim-normalizer",
) -> str:
    """Create a commit and return its id."""
    data = _gql(srv, tok, """
        mutation($commit: CommitCreateInput!) {
            commitCreate(commit: $commit)
        }
    """, {"commit": {
        "streamId":          stream_id,
        "branchName":        branch_name,
        "objectId":          object_id,
        "message":           message,
        "sourceApplication": source_application,
    }})
    return data["commitCreate"]


def _get_branch_id(srv: str, tok: str, stream_id: str, branch_name: str) -> str | None:
    """Look up a branch's server id by name — needed for send3()'s model_id
    argument (send3/model_ingestion.create address a "Model" by id, not
    name), unlike commitCreate's classic path which only ever needs the
    name. Call after _ensure_branch() has guaranteed the branch exists."""
    data = _gql(srv, tok, """
        query($streamId: String!, $branchName: String!) {
            stream(id: $streamId) {
                branch(name: $branchName) { id }
            }
        }
    """, {"streamId": stream_id, "branchName": branch_name})
    branch = data["stream"]["branch"]
    return branch["id"] if branch else None


def _send_native_bundle(
    units: list[dict],
    model_units: str,
    stream_id: str,
    branch_name: str,
    token: str,
    server_url: str,
    message: str,
) -> dict:
    """
    Author and upload a bundle-format version for exactly the given units
    (from speckle/fetch.py's fetch_bundle_selection) via specklepy's native
    BundleBuilder + operations.send3(), instead of the classic operations.
    send() + commitCreate mutation filter_and_publish otherwise uses.

    Only meaningful/attempted when the *source* commit was itself bundle-
    format (see filter_and_publish) — there is no requirement to do this
    (app.speckle.systems still fully accepts classic commitCreate today, see
    create_viewer_bridge, which depends on that remaining true forever since
    @speckle/viewer can't render bundle refs at all), but it keeps a
    republished subset of a "4.0"-native project in the same native format
    as its source, rather than silently downgrading every filtered copy back
    to the classic format. Every object gets one flat "Filtered Selection"
    container — reconstructing the original spatial/collection hierarchy for
    just an arbitrary element subset isn't attempted.

    Raises on any failure (auth, no /api/v2 support on this server, a
    malformed unit, ...) — filter_and_publish catches this and falls back to
    the classic path; this function itself does no fallback.

    Returns {"commit_id": version_id, "branch_name": branch_name,
    "url": ...} matching filter_and_publish's classic-path return shape.
    """
    from specklepy.api.credentials import Account
    from specklepy.bundle.builder import BundleBuilder
    from specklepy.bundle.envelope_writer import Producer
    from specklepy.bundle.send import SendOptions

    if not units:
        # fetch_bundle_selection only resolves ids that trace back to a real
        # ModelObject. Some of the classic tree's leaves don't: to_base()'s
        # _attach_instance_definitions emits a synthetic "def-geo-{k}" object
        # for every geometry belonging to an INSTANCE DEFINITION regardless
        # of whether any placed object's own placement chain ever reaches
        # it — an orphan/catalog entry, not a leaf fetch_bundle_selection's
        # object-driven walk can rebuild. A selection made up entirely of
        # such ids (confirmed live: this can be *every* leaf at the very
        # start of flatten_elements' traversal order) would otherwise upload
        # a bundle with zero objects, which the server accepts as "created"
        # but never becomes queryable afterwards. Fail fast here instead so
        # filter_and_publish's classic fallback (which clones the already-
        # resolved classic tree nodes directly, orphans included) handles it.
        raise ValueError("selection resolved to zero bundle objects — nothing to author natively")

    account = Account.from_token(token, server_url)
    producer = Producer(slug="bim-normalizer", version="1.0")

    _ensure_branch(server_url, token, stream_id, branch_name)
    model_id = _get_branch_id(server_url, token, stream_id, branch_name)
    if not model_id:
        raise ValueError(f"Could not resolve branch id for {branch_name!r} on stream {stream_id}")

    builder = BundleBuilder(producer, units=model_units or "m")
    container = builder.get_or_add_container_path(["Filtered Selection"])

    for unit in units:
        obj = builder.get_or_add_object(unit["key"])
        root_scalars = [
            (k, v) for k, v in (("ifcType", unit["ifc_type"]), ("category", unit["category"]))
            if v
        ]
        obj.set_properties(unit["properties"] or {}, name=unit["name"], root_scalars=root_scalars)
        # Deliberately not BundleObject.add_raw_geometry(): it wires a SOLID
        # relation (pipeline.solid), but the classic-tree projection this
        # bundle must round-trip through (to_base()'s _geometry_object) only
        # ever reads DISPLAY relations — confirmed live: using add_raw_
        # geometry produced a bundle that uploaded and viewer-bridged fine
        # but round-tripped to zero elements on re-ingest, since every
        # object's `displays` list came back empty. Calling the lower-level
        # pipeline directly to wire DISPLAY instead is the raw-bytes
        # equivalent of BundleObject.add_geometry() (which requires an
        # already-decoded specklepy geometry object to re-encode via sgeo —
        # not usable for byte-for-byte passthrough).
        for i, (content, geometry_type) in enumerate(unit["geometries"]):
            geometry_k = builder.pipeline.add_raw_geometry(f"{unit['key']}:g{i}", content, geometry_type)
            builder.pipeline.display(obj.k, geometry_k, i)
        obj.collection = container
        if unit["level_name"]:
            obj.level = builder.get_or_add_level(
                unit["level_name"], unit["level_name"], unit["level_elevation"] or 0.0)
        if unit["material_argb"] is not None:
            obj.material = builder.get_or_add_material(f"mat-{unit['material_argb']}", None, unit["material_argb"])

    result = operations.send3(account, stream_id, model_id, builder, SendOptions(message=message))
    logger.info(
        "Published native bundle version %s on branch %r (stream %s, %d objects)",
        result.version_id, branch_name, stream_id, result.object_count,
    )
    return {
        "commit_id": result.version_id,
        "branch_name": branch_name,
        "url": f"{server_url}/projects/{stream_id}/models/{model_id}@{result.version_id}",
    }


# Public (not _-prefixed): pipeline.normalize.ingest_commit imports this too,
# to reject direct ingest of the branch's own commits — see the guard there.
BRIDGE_BRANCH = "bim-normalizer-viewer-bridge"


def create_viewer_bridge(
    root: Base,
    stream_id: str,
    token: str,
    server_url: str,
    source_commit_id: str,
) -> dict | None:
    """Republish an already-fetched bundle-format commit's tree as a classic
    commit on a dedicated branch of the SAME stream/server, so
    @speckle/viewer's SpeckleLoader (REST /objects/{oid}, no bundle support)
    can render it. Best-effort: any failure (most commonly the ingest token
    lacking write access on the source stream) is caught and logged here —
    a bridge failure must never fail the overall ingest, since BIM data
    ingest is the primary job and only 3D rendering depends on this.

    Returns {"stream_id", "commit_id", "server_url"} on success, else None.
    """
    try:
        client = get_client(server_url=server_url, token=token)
        _ensure_branch(
            server_url, token, stream_id, BRIDGE_BRANCH,
            description="Auto-created by bim-normalizer to republish "
                         "bundle-format commits as classic-format so the "
                         "3D viewer can render them",
        )
        transport = ServerTransport(client=client, stream_id=stream_id)
        obj_id = operations.send(root, [transport])
        new_commit_id = _create_commit(
            server_url, token, stream_id, obj_id, BRIDGE_BRANCH,
            message=f"Viewer bridge for bundle-format commit {source_commit_id}",
            source_application="bim-normalizer-bridge",
        )
        logger.info(
            "Created viewer-bridge commit %s on branch %r (stream %s) for source commit %s",
            new_commit_id, BRIDGE_BRANCH, stream_id, source_commit_id,
        )
        return {"stream_id": stream_id, "commit_id": new_commit_id, "server_url": server_url}
    except Exception as exc:
        logger.warning(
            "Viewer bridge publish failed for commit %s on stream %s (%s): %s — "
            "3D viewer unavailable for this commit; ingest continues unaffected",
            source_commit_id, stream_id, type(exc).__name__, exc,
        )
        return None


def filter_and_publish(
    stream_id: str,
    commit_id: str,
    speckle_ids: set[str],
    target_branch: str,
    message: str,
    token: str | None = None,
    server_url: str | None = None,
) -> dict:
    """
    Fetch a Speckle commit, filter to the given speckle_ids, and publish
    the selection as a new commit on target_branch.

    The original collection hierarchy is preserved: only containers that
    contain at least one selected element are included; empty branches are
    pruned.

    Returns {commit_id, branch_name, element_count, url}.
    """
    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")

    client = get_client(server_url=srv, token=tok)

    root, meta = fetch_commit(stream_id, commit_id, token=tok, server_url=srv)

    id_set = set(speckle_ids)
    new_root, element_count = _filter_tree(
        root, id_set,
        bundle_levels=meta.get("bundle_levels"),
        bundle_classification=meta.get("bundle_classification"),
    )

    total_elements = len(flatten_elements(root))
    logger.info(
        "filter_and_publish: %d/%d elements selected from commit %s",
        element_count, total_elements, commit_id,
    )

    if new_root is None:
        raise ValueError(
            f"No elements matched the filter "
            f"({total_elements} total elements in commit)"
        )

    # Update the root name to reflect it is a filtered subset
    original_name = getattr(root, "name", None) or "Model"
    new_root["name"] = f"{original_name} (filtered)"

    commit_message = message or f"Filtered: {element_count} elements"
    native_result = None

    # If the source was bundle-format, try to keep the republished subset in
    # the same native format rather than always downgrading it to classic —
    # see _send_native_bundle's docstring. Best-effort: any failure (most
    # commonly a server without /api/v2 support, or a malformed unit) falls
    # back to the classic publish path below, exactly like create_viewer_
    # bridge falls back to "no viewer" rather than failing the whole publish.
    if meta.get("is_bundle"):
        try:
            units, model_units = fetch_bundle_selection(
                meta["object_id"],
                ServerTransport(client=client, stream_id=stream_id),
                id_set,
            )
            native_result = _send_native_bundle(
                units, model_units, stream_id, target_branch, tok, srv, commit_message)
            logger.info("Published filtered selection as a native bundle version (commit %s)",
                        native_result["commit_id"])
        except Exception as exc:
            logger.warning(
                "Native bundle publish failed for filtered selection on stream %s (%s): %s — "
                "falling back to classic-format publish",
                stream_id, type(exc).__name__, exc,
            )
            native_result = None

    if native_result is not None:
        new_commit_id = native_result["commit_id"]
        result_url = native_result["url"]
    else:
        _ensure_branch(srv, tok, stream_id, target_branch)

        transport = ServerTransport(client=client, stream_id=stream_id)
        obj_id = operations.send(new_root, [transport])
        logger.info("Sent filtered object tree: id=%s (%d elements)", obj_id, element_count)

        original_app = meta.get("source_application") or "bim-normalizer"
        new_commit_id = _create_commit(
            srv, tok, stream_id, obj_id, target_branch, commit_message,
            source_application=original_app,
        )
        logger.info("Created commit %s on branch %r", new_commit_id, target_branch)
        result_url = f"{srv}/streams/{stream_id}/commits/{new_commit_id}"

    # Ingest the new commit so the published model has the same normalized
    # structure (bim_elements/parameters) as the source model in the dashboard.
    from pipeline.normalize import ingest_commit
    ingest_result = ingest_commit(stream_id, new_commit_id, token=tok, server_url=srv, forced_source="filtered")
    logger.info(
        "Ingested filtered commit %s: model_id=%s element_count=%d",
        new_commit_id, ingest_result["model_id"], ingest_result["element_count"],
    )

    return {
        "commit_id": new_commit_id,
        "branch_name": target_branch,
        "element_count": element_count,
        "model_id": ingest_result["model_id"],
        "ingested_element_count": ingest_result["element_count"],
        "url": result_url,
    }
