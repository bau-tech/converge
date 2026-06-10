import logging
import os

import requests
from specklepy.api import operations
from specklepy.objects import Base
from specklepy.transports.server import ServerTransport
from specklepy.transports.sqlite import SQLiteTransport

from config import settings
from ifc.classify import _REVIT_CATEGORY_MAP
from speckle.client import get_client

logger = logging.getLogger(__name__)

# Directory for the SQLite object cache — created once at import time.
# The transport itself is created per-call inside fetch_commit so that the
# sqlite3 connection is always opened and used in the same thread.
_cache_path = os.path.join(os.path.dirname(__file__), "..", ".speckle_cache")
try:
    os.makedirs(_cache_path, exist_ok=True)
except Exception:
    _cache_path = None


def _make_sqlite_transport():
    """Create a SQLiteTransport in the calling thread. Returns None on failure."""
    if _cache_path is None:
        return None
    try:
        return SQLiteTransport(base_path=_cache_path)
    except Exception as e:
        logger.warning("SQLite cache unavailable (%s) — fetching without local caching", e)
        return None

# Geometry and proxy types that are not BIM elements
_SKIP_FRAGMENTS = [
    "Objects.Geometry.Mesh",
    "Speckle.Core.Models.DataChunk",
    "Objects.Geometry.Line",
    "Objects.Geometry.Point",
    "Objects.Geometry.Polyline",
    "Objects.Geometry.Brep",
    "Objects.Geometry.Surface",
    "Objects.Other.RenderMaterial",
    # Rebar: be specific — "Rebar" alone would also skip TeklaRebar which IS a BIM element
    "RebarInSystem",
    "AreaReinforcement",
    "PathReinforcement",
    "RevitRebar",
    "Material",
    "RenderMaterial",
    "RevitMaterial",
    "BuiltElements.Revit.RevitMaterial",
    "InstanceProxy",
    "InstanceDefinitionProxy",
    "GroupProxy",
    "MaterialProxy",
    "Instances.Instance",
    "Proxies.",
]


def _should_skip(speckle_type: str) -> bool:
    return any(frag in speckle_type for frag in _SKIP_FRAGMENTS)


def _fetch_commit_meta(stream_id: str, commit_id: str, token: str,
                       server_url: str = None) -> dict:
    """
    Fetch commit metadata + referencedObject via GraphQL.
    Avoids relying on client.commit which changed across specklepy versions.
    """
    query = """
    query GetCommit($streamId: String!, $commitId: String!) {
        stream(id: $streamId) {
            commit(id: $commitId) {
                referencedObject
                branchName
                authorName
                message
                sourceApplication
            }
        }
    }
    """
    url = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    resp = requests.post(
        f"{url}/graphql",
        json={"query": query, "variables": {"streamId": stream_id, "commitId": commit_id}},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
        verify=True,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")
    commit = body["data"]["stream"]["commit"]
    if commit is None:
        raise ValueError(f"Commit {commit_id} not found in stream {stream_id}")
    return commit


def fetch_commit(stream_id: str, commit_id: str, token: str = None,
                 server_url: str = None) -> tuple[Base, dict]:
    """
    Returns (root_object, commit_meta).
    Commit metadata is fetched via direct GraphQL; object tree via specklepy transport.
    """
    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    if not tok:
        raise ValueError("SPECKLE_TOKEN is not configured")

    commit = _fetch_commit_meta(stream_id, commit_id, tok, server_url=srv)
    obj_id = commit["referencedObject"]

    meta = {
        "branch_name":        commit.get("branchName") or "",
        "author":             commit.get("authorName") or "",
        "message":            commit.get("message") or "",
        "source_application": commit.get("sourceApplication") or "",
    }

    client = get_client(server_url=srv, token=tok)
    transport = ServerTransport(client=client, stream_id=stream_id)
    root = operations.receive(
        obj_id=obj_id,
        remote_transport=transport,
        local_transport=_make_sqlite_transport(),
    )
    logger.info("Received commit %s from stream %s (%d bytes referenced)",
                commit_id, stream_id, len(obj_id))
    return root, meta


def flatten_elements(
    root: Base,
    _depth: int = 0,
    _max_depth: int = 50,
    _parent_name: str = "",
) -> list[tuple]:
    """
    Recursively traverse the Speckle object tree and return all leaf BIM elements.

    Returns a list of (Base, category_hint) tuples.  The category_hint is the
    name of the nearest ancestor Collection that matches a known Revit category
    (e.g. "Walls", "Structural Framing").  Callers must use this hint rather than
    reading it from the Base object — we never mutate the SpecklePy object.

    Revit v3 organises elements inside Collections whose `name` IS the Revit category.
    Type/family names ("Basic Wall: Generic 200mm") are NOT promoted — only names
    present in _REVIT_CATEGORY_MAP propagate downward.
    """
    if _depth > _max_depth:
        return []

    results: list[tuple] = []
    elements = getattr(root, "elements", None) or []

    for child in elements:
        if not isinstance(child, Base):
            continue

        st = getattr(child, "speckle_type", "") or ""

        if _should_skip(st):
            continue

        # Log Tekla element types at info level on first encounter (depth 0 or 1) to aid diagnosis
        if _depth <= 1 and "Tekla" in st:
            child_name = getattr(child, "name", "") or ""
            obj_type = getattr(child, "type", "") or ""
            logger.info(
                "flatten[Tekla depth=%d]: speckle_type=%r  name=%r  obj.type=%r  category=%r",
                _depth, st, child_name, obj_type, getattr(child, "category", None),
            )

        # Container types: recurse but do NOT add as a leaf element.
        # Includes: Speckle Collection/Model/Folder, Tekla Phase/Layer containers.
        is_container = (
            "Collection" in st or "Model" in st or "Folder" in st
            or "TeklaPhase" in st or "TeklaLayer" in st
        )

        if is_container:
            child_name = getattr(child, "name", "") or ""
            # Only promote collection name when it is a recognised Revit category.
            next_parent = child_name if child_name in _REVIT_CATEGORY_MAP else _parent_name
            if _depth == 0:
                logger.debug("flatten: collection name=%r  next_hint=%r", child_name, next_parent)
            results.extend(flatten_elements(child, _depth + 1, _max_depth, next_parent))
        else:
            results.append((child, _parent_name))
            # Do NOT recurse into TeklaObject children.
            # A TeklaObject's elements are construction operations (BooleanPart,
            # Fitting, CutPlane) — not standalone BIM elements.  All meaningful
            # Tekla BIM elements are placed directly inside the type collections
            # by SendCollectionManager, so recursing here only creates duplicates
            # and Generic-Models noise.
            if getattr(child, "elements", None) and st != "Objects.Data.TeklaObject":
                results.extend(flatten_elements(child, _depth + 1, _max_depth, _parent_name))

    return results


def build_object_map(root: Base) -> dict:
    """
    Walk every Base object reachable from root and return a flat map keyed by
    both Speckle id and applicationId.  Used to resolve string ID references
    found in InstanceDefinitionProxy.objects (Speckle v3 connector).
    """
    obj_map: dict[str, Base] = {}
    visited: set[str] = set()

    def _walk(obj: Base):
        obj_id = str(getattr(obj, "id", "") or "")
        if obj_id:
            if obj_id in visited:
                return
            visited.add(obj_id)
        app_id = str(getattr(obj, "applicationId", "") or "")
        if obj_id:
            obj_map[obj_id] = obj
        if app_id and app_id != obj_id:
            obj_map[app_id] = obj
        try:
            for v in obj.__dict__.values():
                if isinstance(v, Base):
                    _walk(v)
                elif isinstance(v, (list, tuple)):
                    for item in v:
                        if isinstance(item, Base):
                            _walk(item)
        except Exception:
            pass

    _walk(root)
    return obj_map


def collect_instance_definitions(root: Base) -> dict:
    """
    Return all InstanceDefinitionProxy objects keyed by their id.
    In Speckle v3, structural family instances (beams, columns) store geometry
    on these shared definition objects rather than on each instance directly.

    Strategy: walk every attribute of root.__dict__ and collect any Base object
    (or list member) whose speckle_type contains "DefinitionProxy".  This avoids
    hard-coding the attribute name, which varies across connector versions.
    """
    defs: dict[str, Base] = {}

    try:
        raw_dict = root.__dict__
    except Exception:
        return defs

    for _attr, val in raw_dict.items():
        items = val if isinstance(val, list) else [val]
        for item in items:
            if not isinstance(item, Base):
                continue
            st = getattr(item, "speckle_type", "") or ""
            if "DefinitionProxy" in st:
                # InstanceProxy.definitionId references applicationId (Revit UniqueId),
                # not the Speckle hash id — index by both to cover all cases
                for key_attr in ("applicationId", "id"):
                    def_key = getattr(item, key_attr, None)
                    if def_key:
                        defs[str(def_key)] = item

    logger.info("Collected %d instance definition proxies from commit root", len(defs))
    return defs


def detect_source(root: Base, source_app: str = "") -> str:
    """Detect connector source from root object or sourceApplication metadata."""
    sa = (source_app or "").lower()
    if "revit" in sa:
        return "Revit"
    if "tekla" in sa:
        return "Tekla"
    if "ifc" in sa or "open" in sa:
        return "IFC"
    if "navisworks" in sa:
        return "Navisworks"
    if "blender" in sa:
        return "Blender"
    if "rhino" in sa:
        return "Rhino"
    if "grasshopper" in sa:
        return "Grasshopper"

    for child in (getattr(root, "elements", None) or []):
        st = getattr(child, "speckle_type", "") or ""
        ct = (getattr(child, "collectionType", None) or "").lower()
        if "Revit" in st:
            return "Revit"
        if "Tekla" in st:
            return "Tekla"
        if "Ifc" in st:
            return "IFC"
        if "Navisworks" in st:
            return "Navisworks"
        if "blender" in ct:
            return "Blender"

    return "Generic"
