import logging

import requests as _requests
from specklepy.api import operations
from specklepy.objects import Base
from specklepy.transports.server import ServerTransport

from config import settings
from speckle.client import get_client
from speckle.fetch import fetch_commit, flatten_elements, _should_skip

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
) -> tuple[Base | None, int]:
    """
    Recursively clone the Speckle object tree keeping only the elements
    whose `id` is in *id_set*.

    Container nodes (Collection, Model, Folder, …) are cloned and kept
    only when at least one descendant matches.  Pure-geometry fragments
    (Mesh, Line, RenderMaterial, …) are always dropped.

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
            filtered, count = _filter_tree(child, id_set, depth + 1, max_depth)
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
        new_node["@elements"] = kept
        return new_node, total

    # Leaf element: keep as-is if selected
    node_id = getattr(node, "id", None)
    if node_id in id_set:
        return node, 1
    return None, 0


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


def _ensure_branch(srv: str, tok: str, stream_id: str, branch_name: str) -> None:
    """Create branch if it doesn't already exist."""
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
        "description": "Created by bim-normalizer filter-publish",
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
    new_root, element_count = _filter_tree(root, id_set)

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

    _ensure_branch(srv, tok, stream_id, target_branch)

    transport = ServerTransport(client=client, stream_id=stream_id)
    obj_id = operations.send(new_root, [transport])
    logger.info("Sent filtered object tree: id=%s (%d elements)", obj_id, element_count)

    original_app = meta.get("source_application") or "bim-normalizer"
    commit_message = message or f"Filtered: {element_count} elements"
    new_commit_id = _create_commit(
        srv, tok, stream_id, obj_id, target_branch, commit_message,
        source_application=original_app,
    )
    logger.info("Created commit %s on branch %r", new_commit_id, target_branch)

    return {
        "commit_id": new_commit_id,
        "branch_name": target_branch,
        "element_count": element_count,
        "url": f"{srv}/streams/{stream_id}/commits/{new_commit_id}",
    }
