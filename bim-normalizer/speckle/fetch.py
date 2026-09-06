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


def _child_elements(obj: Base) -> list | None:
    """Read an object's child collection, checking both the plain `elements`
    attribute and specklepy's `@elements` "detached property" convention —
    Speckle's own server-side IFC FileImportService puts every aggregated
    child (e.g. an IfcStair's IfcRailing/IfcMember/IfcStairFlight, related via
    IFC's Decomposes/IfcRelAggregates) under `@elements`, not `elements`;
    Revit/Tekla connector output observed elsewhere in this file uses the
    plain name. Confirmed via a live ingest of a native-IFC-imported Speckle
    commit where `getattr(child, "elements", None)` silently returned None
    for every aggregated child, dropping them from flatten_elements' results
    entirely (no error, no fallback — they just never appeared)."""
    return getattr(obj, "elements", None) or getattr(obj, "@elements", None)


def _gql_request(url: str, token: str, query: str, variables: dict) -> dict:
    resp = requests.post(
        f"{url}/graphql",
        json={"query": query, "variables": variables},
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=30,
        verify=True,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")
    return body["data"]


_NOT_FOUND_RETRY_DELAYS_S = (1, 2, 3, 4, 5)  # ~15s total budget


def _fetch_commit_or_version(stream_id: str, commit_id: str, token: str, url: str) -> dict | None:
    """One (non-retried) attempt: classic stream.commit(id), then the v2
    project.version(id) fallback. Returns None — never raises — when neither
    finds anything, so the caller's retry loop can distinguish "not found
    yet" (worth retrying) from a genuine request failure."""
    data = _gql_request(url, token, """
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
    """, {"streamId": stream_id, "commitId": commit_id})
    commit = (data.get("stream") or {}).get("commit")
    if commit is not None:
        return commit

    try:
        data = _gql_request(url, token, """
            query GetVersion($projectId: String!, $versionId: String!) {
                project(id: $projectId) {
                    version(id: $versionId) {
                        referencedObject
                        message
                        sourceApplication
                        authorUser { name }
                        model { name }
                    }
                }
            }
        """, {"projectId": stream_id, "versionId": commit_id})
    except ValueError:
        # "Version not found" surfaces as a GraphQL error here, not a null
        # field like the classic query above — same "not found" outcome.
        return None
    version = (data.get("project") or {}).get("version")
    if version is None:
        return None
    return {
        "referencedObject":  version.get("referencedObject"),
        "branchName":        (version.get("model") or {}).get("name"),
        "authorName":        (version.get("authorUser") or {}).get("name"),
        "message":           version.get("message"),
        "sourceApplication": version.get("sourceApplication"),
    }


def _fetch_commit_meta(stream_id: str, commit_id: str, token: str,
                       server_url: str = None) -> dict:
    """
    Fetch commit metadata + referencedObject via GraphQL.
    Avoids relying on client.commit which changed across specklepy versions.

    Tries the classic stream.commit(id) query first, then falls back to the
    newer project.version(id) query — needed for versions published via
    specklepy's native send3() (speckle/publish.py's _send_native_bundle):
    the same modern /api/v2 ingestion rail that produces the bundle-format
    versions this whole module exists to read is queryable via
    project.version(id) but not stream.commit(id), on the same server, for
    the same id. Whatever legacy "commits" table/view stream.commit(id)
    reads from isn't kept in sync for versions created this way — an
    independent gap from the referencedObject "bundle." format itself (e.g.
    app.speckle.systems's own web IFC importer produces bundle-format
    commits that DO resolve via stream.commit(id) fine).

    Retries both queries a few times on "not found": confirmed live that
    app.speckle.systems has a real, short (single-digit seconds) eventual-
    consistency lag after a write — reproduced with a completely ordinary
    *classic* commitCreate mutation immediately followed by this same
    stream.commit(id) query, so this isn't specific to the new ingestion
    rail either. Every other caller of this function reads a commit created
    well in the past, so this only ever adds latency right after a publish.
    """
    import time as _time

    url = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")

    result = _fetch_commit_or_version(stream_id, commit_id, token, url)
    for delay in _NOT_FOUND_RETRY_DELAYS_S:
        if result is not None:
            return result
        logger.info(
            "Commit/version %s not found yet in stream %s — retrying in %ds "
            "(app.speckle.systems has a short eventual-consistency lag after a write)",
            commit_id, stream_id, delay,
        )
        _time.sleep(delay)
        result = _fetch_commit_or_version(stream_id, commit_id, token, url)

    if result is None:
        raise ValueError(f"Commit {commit_id} not found in stream {stream_id}")
    return result


def _resolved_keys(obj) -> list[str]:
    """
    Every id a bundle ModelObject can appear under on the *classic* tree
    to_base() produces — see _fetch_bundle's docstring for why an instanced
    object's geometry surfaces under a synthetic "def-geo-{k}" id decoupled
    from the object node itself, while an un-instanced object keeps its own
    applicationId. Used to key every per-object signal (level, classification,
    relations) so pipeline.normalize can look them up by the same speckle_id
    flatten_elements' leaves carry.
    """
    return [obj.application_id] + [f"def-geo-{g.k}" for g in obj.geometries]


# Relation types extracted into bim_relationships by db/insert.py's
# insert_bundle_relationships — object<->object only (object<->node relations
# like IN_SYSTEM/IN_GROUP have no bim_elements row to point at and are out of
# scope: bim_relationships references two elements, not an element and an
# abstract container). IN_ROOM and BOUNDS are the same semantic link from
# opposite ends of the spec's redundant pair — only IN_ROOM is extracted, to
# avoid writing the same containment twice under two names.
_BUNDLE_RELATION_TYPES = ("hosted_on", "connects_to", "in_assembly", "in_room")


def _fetch_bundle(obj_id: str, transport: ServerTransport):
    """
    Fetch a bundle-format commit via specklepy's native operations.receive3()
    instead of going through the classic operations.receive() -> Model.to_base()
    compatibility shim. We still call to_base() ourselves — it correctly carries
    over geometry/properties/materials, so the rest of this pipeline (flatten_
    elements, classify_element, extract_geometry, ...) doesn't need to change —
    but doing it via the native Model first also gives us relation-graph data
    to_base() silently drops on the floor:

    - ON_LEVEL (ModelObject.level): to_base()'s Collection tree is built only
      from CONTAINER-kind nodes; it never reads NodeKind.LEVEL nodes at all.
    - ifcType/category root scalars (ModelObject.root_properties): to_base()'s
      property projection only copies paths under the "properties." prefix
      (see base_projection._geometry_object's `table.under(object_k,
      "properties")`) — but specklepy's own EAV producer (eav_extraction.py)
      writes ifcType/category/level/family/type as *bare* root scalars,
      outside that prefix. Any sender that populates them is invisible to
      classify_element() through the classic tree.
    - HOSTED_ON/CONNECTS_TO/IN_ASSEMBLY/IN_ROOM (ModelObject.host/
      connected_to/assembly/room): object<->object relations with literally no
      projection in to_base() at all, lossy or otherwise.

    All three are confirmed by reading specklepy 2026.9.0b3's source directly
    (base_projection.py has no LEVEL/ON_LEVEL/root-scalar/relation handling
    whatsoever) — none of this is specific to any one exporter.

    Returns (root, levels, classification, relations):
      - levels: leaf id -> level name (ON_LEVEL), as before.
      - classification: leaf id -> (ifcType, category), either may be None.
      - relations: list of (from_leaf_id, to_leaf_id, relation_type) triples,
        relation_type one of _BUNDLE_RELATION_TYPES.
    Every dict/list is keyed by _resolved_keys(obj) — see its docstring for
    why a leaf id is not simply the object's own applicationId. All empty if
    the bundle carries none of this — e.g. a source that models storeys as
    plain Collections and skips properties/relations entirely, as
    app.speckle.systems's alpha IFC importer was observed doing on
    2026-09-06; pipeline.normalize's collect_instance_storeys() heuristic
    stays in place as a level fallback for exactly that case.
    """
    from specklepy.bundle.download import BundleReference

    parsed = BundleReference.parse(obj_id)
    account = transport.account
    if account is None:
        raise ValueError("bundle receive requires an authenticated ServerTransport (transport.account is None)")

    with operations.receive3(account, parsed.project_id, parsed.model_id, parsed.version_id) as model:
        root = model.to_base()
        levels: dict[str, str] = {}
        classification: dict[str, tuple[str | None, str | None]] = {}
        relations: list[tuple[str, str, str]] = []

        for obj in model.objects:
            level = obj.level
            level_name = level.name if (level is not None and level.name) else None
            ifc_type = obj.root_properties.get_string("ifcType")
            category = obj.root_properties.get_string("category")

            related_pairs: list[tuple[object, str]] = []
            host = obj.host
            if host is not None:
                related_pairs.append((host, "hosted_on"))
            for connected in obj.connected_to:
                related_pairs.append((connected, "connects_to"))
            assembly = obj.assembly
            if assembly is not None:
                related_pairs.append((assembly, "in_assembly"))
            room = obj.room
            if room is not None:
                related_pairs.append((room, "in_room"))

            if not (level_name or ifc_type or category or related_pairs):
                continue

            keys = _resolved_keys(obj)
            for key in keys:
                if level_name:
                    levels[key] = level_name
                if ifc_type or category:
                    classification[key] = (ifc_type, category)
            if related_pairs and keys:
                for related_obj, relation_type in related_pairs:
                    for to_key in _resolved_keys(related_obj):
                        relations.append((keys[0], to_key, relation_type))

    return root, levels, classification, relations


def fetch_bundle_selection(obj_id: str, transport: ServerTransport, id_set: set[str]) -> tuple[list[dict], str]:
    """
    Native-Model extraction for speckle/publish.py's native bundle-authoring
    path (used by filter_and_publish when the source commit is bundle-format,
    to republish a filtered selection as a bundle version instead of a
    classic commit): for exactly the leaf ids in id_set (same key scheme as
    _fetch_bundle/_resolved_keys), return one dict per surviving bundle
    object, carrying everything needed to author a new bundle — pulled
    straight from the bundle's own tables, with geometry passed through
    byte-for-byte (BundleObject.add_raw_geometry, no SGEO re-encoding/no
    round-trip through sgeo.decode()+re-encode) rather than via the classic
    Base tree, which has already thrown away level/ifcType/category by the
    time _filter_tree ever sees it.

    Placements are baked flat: an instanced object's geometries each become
    their own standalone bundle object carrying the parent object's
    properties/level/name (matching to_base()'s own "def-geo-{k}" id scheme
    for the *selection* ids this must match against) — simpler and lower-
    risk than reproducing the original instance/definition sharing graph, at
    the cost of losing that de-duplication in the republished copy. An
    un-instanced object keeps its own applicationId and keeps every one of
    its geometries under that single object (matching how to_base()'s
    _geometry_object folds multiple direct displays into one DataObject).

    Returns (units, model_units): each unit dict is {key, geometries:
    [(content: bytes, type: str), ...], name, ifc_type, category, properties
    (nested dict), level_name, level_elevation, material_argb}; model_units
    is the bundle's own length unit (e.g. "m"), for BundleBuilder's required
    units= constructor argument.
    """
    from specklepy.bundle.download import BundleReference

    parsed = BundleReference.parse(obj_id)
    account = transport.account
    if account is None:
        raise ValueError("bundle receive requires an authenticated ServerTransport (transport.account is None)")

    units: list[dict] = []
    with operations.receive3(account, parsed.project_id, parsed.model_id, parsed.version_id) as model:
        model_units = model.units
        for obj in model.objects:
            geometries = obj.geometries
            if not geometries:
                continue

            is_instanced = bool(obj.placements)
            level = obj.level
            material = obj.material
            unit_common = {
                "name": obj.name,
                "ifc_type": obj.root_properties.get_string("ifcType"),
                "category": obj.root_properties.get_string("category"),
                "properties": obj.properties.to_nested(),
                "level_name": level.name if (level is not None and level.name) else None,
                "level_elevation": level.elevation if level is not None else None,
                "material_argb": material.argb if material is not None else None,
            }

            if is_instanced:
                for g in geometries:
                    key = f"def-geo-{g.k}"
                    if key not in id_set:
                        continue
                    unit = dict(unit_common, key=key, geometries=[(g.content, g.type)])
                    if unit["material_argb"] is None and g.effective_material is not None:
                        unit["material_argb"] = g.effective_material.argb
                    units.append(unit)
            else:
                key = obj.application_id
                if key not in id_set:
                    continue
                units.append(dict(
                    unit_common, key=key,
                    geometries=[(g.content, g.type) for g in geometries],
                ))

    return units, model_units


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
        # Resolved referencedObject id — exposed so callers that need the
        # native Model again (e.g. publish.py's native bundle-authoring
        # path) don't have to re-fetch commit metadata just to get it.
        "object_id":          obj_id,
        # Bundle-format objects (a newer Speckle server-side storage format)
        # have ids like "bundle.<streamId>.<hash>.<commitId>" — @speckle/viewer
        # (browser JS) can't fetch these via its classic /objects/{oid} REST
        # endpoint. See pipeline.normalize.ingest_commit's viewer-bridge step.
        "is_bundle":          obj_id.startswith("bundle."),
        "bundle_levels":         {},
        "bundle_classification": {},
        "bundle_relations":      [],
    }

    client = get_client(server_url=srv, token=tok)
    transport = ServerTransport(client=client, stream_id=stream_id)

    if meta["is_bundle"]:
        try:
            (root, meta["bundle_levels"], meta["bundle_classification"],
             meta["bundle_relations"]) = _fetch_bundle(obj_id, transport)
        except Exception as exc:
            logger.warning(
                "Native bundle receive (receive3) failed for commit %s (%s: %s) — "
                "falling back to the classic receive()->to_base() shim. Geometry/"
                "properties/materials are unaffected, but ON_LEVEL storey data "
                "(if this bundle has any) will be lost for this ingest.",
                commit_id, type(exc).__name__, exc,
            )
            root = operations.receive(obj_id=obj_id, remote_transport=transport, local_transport=None)
        logger.info("Received bundle commit %s from stream %s (%d levels resolved)",
                    commit_id, stream_id, len(meta["bundle_levels"]))
        return root, meta

    try:
        root = operations.receive(
            obj_id=obj_id,
            remote_transport=transport,
            local_transport=_make_sqlite_transport(),
        )
    except Exception as exc:
        # A stale/partial local SQLite cache entry (e.g. from a previously
        # interrupted fetch) can corrupt specklepy's closure-table decoding
        # for objects shared across commits, surfacing as opaque errors like
        # "not enough values to unpack". Retry once against the server only —
        # slower, but immune to local cache corruption.
        logger.warning(
            "operations.receive failed with local cache for commit %s (%s) — retrying without cache",
            commit_id, exc,
        )
        root = operations.receive(
            obj_id=obj_id,
            remote_transport=transport,
            local_transport=None,
        )
    logger.info("Received commit %s from stream %s (%d bytes referenced)",
                commit_id, stream_id, len(obj_id))
    return root, meta


def find_original_ifc_blob(
    stream_id: str,
    token: str | None = None,
    server_url: str | None = None,
) -> dict | None:
    """
    Query the Speckle server for IFC file blobs attached to a stream and return
    metadata for the largest successfully-uploaded .ifc blob, or None if no such
    blob exists. Use iter_original_ifc_blob() to stream its bytes.
    """
    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    if not tok:
        return None

    resp = requests.post(
        f"{srv}/graphql",
        json={
            "query": """
                query($id: String!) {
                    stream(id: $id) {
                        blobs(limit: 25) {
                            items { id fileName fileSize uploadStatus }
                        }
                    }
                }
            """,
            "variables": {"id": stream_id},
        },
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")

    items = ((body.get("data") or {}).get("stream") or {}).get("blobs", {}).get("items") or []
    blobs = sorted(
        (b for b in items if b.get("uploadStatus") == 1 and b.get("fileName", "").lower().endswith(".ifc")),
        key=lambda b: b.get("fileSize", 0),
        reverse=True,  # largest file first — most likely the complete original IFC
    )
    if not blobs:
        return None

    blob = blobs[0]
    return {
        "server_url": srv,
        "token": tok,
        "blob_id": blob["id"],
        "filename": blob["fileName"],
        "file_size": blob.get("fileSize"),
    }


def find_original_ifc_blob_for_commit(
    stream_id: str,
    commit_id: str,
    token: str | None = None,
    server_url: str | None = None,
) -> dict | None:
    """
    Return metadata for the IFC file upload that was actually converted into
    this exact commit, via the server's file-upload history (Stream.fileUploads
    → convertedCommitId) — precise per-commit, unlike find_original_ifc_blob()
    which just guesses the largest .ifc blob anywhere on the stream.

    Only falls back to find_original_ifc_blob()'s stream-wide guess when the
    fileUploads lookup itself is unavailable (older/newer Speckle server
    schema variance, network error) — i.e. when we genuinely have no way to
    know either way. When the lookup succeeds but no upload converted into
    this commit (e.g. the commit came from a connector push rather than a
    web-UI "upload file" import), that's a definitive answer: this commit
    has no corresponding file upload, so there is no correct blob to guess
    at. Guessing anyway previously picked the largest .ifc blob ANYWHERE on
    the stream regardless of whether it had anything to do with this commit
    — confirmed to silently return a completely unrelated model's IFC file
    (mismatched element counts, no overlap with the model's own stored
    IfcGUID parameters) on a stream with multiple unrelated .ifc uploads.
    Returning None here is safe: callers (resolve_model_ifc_bytes) already
    treat None as "fall back to bim-normalizer's own synthetic export",
    which is guaranteed to actually be this model's geometry.
    """
    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    if not tok:
        return None

    try:
        resp = requests.post(
            f"{srv}/graphql",
            json={
                "query": """
                    query($id: String!) {
                        stream(id: $id) {
                            fileUploads {
                                id
                                fileName
                                fileSize
                                uploadComplete
                                convertedCommitId
                            }
                        }
                    }
                """,
                "variables": {"id": stream_id},
            },
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        if "errors" in body:
            raise ValueError(f"GraphQL error: {body['errors'][0]['message']}")

        uploads = ((body.get("data") or {}).get("stream") or {}).get("fileUploads") or []
        match = next(
            (
                u for u in uploads
                if u.get("convertedCommitId") == commit_id
                and u.get("uploadComplete")
                and (u.get("fileName") or "").lower().endswith(".ifc")
            ),
            None,
        )
        if match:
            return {
                "server_url": srv,
                "token": tok,
                "blob_id": match["id"],
                "filename": match["fileName"],
                "file_size": match.get("fileSize"),
            }
        logger.info(
            "No file-upload matched commit %s on stream %s — this commit has no "
            "corresponding original IFC (likely a connector push, not a file "
            "upload); using bim-normalizer's synthetic export instead of "
            "guessing at an unrelated blob",
            commit_id, stream_id,
        )
        return None
    except Exception as exc:
        logger.info(
            "fileUploads lookup unavailable for stream %s (%s) — falling back to stream-wide IFC blob search",
            stream_id, exc,
        )
        return find_original_ifc_blob(stream_id, tok, srv)


def iter_original_ifc_blob(stream_id: str, blob: dict, chunk_size: int = 1024 * 1024):
    """
    Stream the bytes of a blob located via find_original_ifc_blob(), without
    buffering the whole file in memory. timeout=(connect, read) applies per
    socket read, not to the whole transfer, so it stays valid for large files.
    """
    with requests.get(
        f"{blob['server_url']}/api/stream/{stream_id}/blob/{blob['blob_id']}",
        headers={"Authorization": f"Bearer {blob['token']}"},
        stream=True,
        timeout=(10, 120),
    ) as dl:
        dl.raise_for_status()
        for chunk in dl.iter_content(chunk_size=chunk_size):
            if chunk:
                yield chunk


def fetch_original_ifc_bytes(
    stream_id: str,
    token: str | None = None,
    server_url: str | None = None,
    commit_id: str | None = None,
) -> bytes | None:
    """
    Return the full bytes of the original IFC file blob attached to a stream,
    or None if no such blob exists. Convenience wrapper around
    find_original_ifc_blob()/iter_original_ifc_blob() for callers that need
    the whole file in memory (e.g. running an IDS check against the real
    exporter output) rather than streaming it straight to an HTTP response.

    Pass commit_id to scope the lookup to the exact upload that produced that
    commit (find_original_ifc_blob_for_commit) instead of just grabbing the
    largest .ifc blob anywhere on the stream.
    """
    blob = (
        find_original_ifc_blob_for_commit(stream_id, commit_id, token, server_url)
        if commit_id
        else find_original_ifc_blob(stream_id, token, server_url)
    )
    if blob is None:
        return None
    return b"".join(iter_original_ifc_blob(stream_id, blob))


def flatten_elements(
    root: Base,
    _depth: int = 0,
    _max_depth: int = 50,
    _parent_name: str = "",
    _seen_ids: set | None = None,
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

    Speckle's object graph is a DAG, not strictly a tree — the same object.id
    can legitimately be referenced from more than one parent's `elements`
    (confirmed live: a Tekla bolted-connection "Fitting" shared between the
    two connected members' own element lists). `_seen_ids` is threaded
    through the recursion (same set object passed to every call, only
    created fresh at the top-level call) so a shared object is emitted at
    most once — without it, such an object is silently duplicated in the
    returned list, which both inflates element_count and, since the DB
    upsert keys on (model_id, speckle_id), makes two rows in the same
    INSERT batch target the same row — Postgres rejects
    "ON CONFLICT DO UPDATE" affecting one row twice in a single statement.
    """
    if _seen_ids is None:
        _seen_ids = set()

    if _depth > _max_depth:
        logger.warning(
            "flatten_elements: max depth %d exceeded at id=%s type=%s — subtree truncated",
            _max_depth, getattr(root, "id", "?"), getattr(root, "speckle_type", "?"),
        )
        return []

    results: list[tuple] = []
    elements = _child_elements(root) or []

    for child in elements:
        if not isinstance(child, Base):
            continue

        st = getattr(child, "speckle_type", "") or ""

        if _should_skip(st):
            continue

        child_id = getattr(child, "id", None)
        if child_id is not None:
            if child_id in _seen_ids:
                continue
            _seen_ids.add(child_id)

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
            results.extend(flatten_elements(child, _depth + 1, _max_depth, next_parent, _seen_ids))
        else:
            results.append((child, _parent_name))
            # Do NOT recurse into TeklaObject children.
            # A TeklaObject's elements are construction operations (BooleanPart,
            # Fitting, CutPlane) — not standalone BIM elements.  All meaningful
            # Tekla BIM elements are placed directly inside the type collections
            # by SendCollectionManager, so recursing here only creates duplicates
            # and Generic-Models noise.
            #
            # A leaf's own nested elements (e.g. a Revit Opening hosted inside a
            # Floor's `.elements`) are NOT necessarily the same category as their
            # host — drop the inherited hint rather than passing `_parent_name`
            # through, so e.g. a floor-hosted Opening classifies from its own
            # speckle_type instead of short-circuiting to "Floors" via
            # classify_element()'s category_hint-first Revit branch.
            if _child_elements(child) and st != "Objects.Data.TeklaObject":
                results.extend(flatten_elements(child, _depth + 1, _max_depth, "", _seen_ids))

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
        except Exception as exc:
            logger.warning("build_object_map: failed walking object %s: %s", obj_id or "?", exc)

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
    except Exception as exc:
        logger.warning("collect_instance_definitions: could not read root.__dict__: %s", exc)
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


# Literal Collection names observed to be generic organisational wrappers
# (the commit root's own name, and a phase-like grouping layer) rather than
# real spatial/storey names — best-effort, not foolproof, since there's no
# IFC class info to tell wrapper collections from storey collections here.
_GENERIC_COLLECTION_NAMES = {"received model", "default"}


def collect_instance_storeys(root: Base, instance_defs: dict) -> dict[str, str]:
    """
    Best-effort storey/level lookup for sources where the real BIM elements
    are Instance/InstanceDefinitionProxy pairs (Speckle v3's IFC web importer
    on app.speckle.systems, observed 2026-09: every element flattens to a
    bare `Objects.Data.DataObject` mesh with NO type/properties/storey of its
    own — flatten_elements() only sees these ungrouped, contextless leaves
    since _should_skip() drops the InstanceProxy layer entirely).

    The InstanceProxy placements DO carry real spatial context: they sit
    nested inside named Collections mirroring the IFC spatial structure
    (Site/Building/Storey, e.g. "Snowdon Towers" > "Elevator Pit"). This walks
    that structure independently of flatten_elements (does not change what
    counts as an element — additive only) and returns
    {resolved_geometry_object_id: storey_name} so pipeline.normalize can
    enrich get_storey()'s result for whichever of flatten_elements' leaves
    happen to match one of these ids. Elements with no InstanceProxy
    placement (e.g. this source's own redundant flat, unplaced duplicates)
    simply get no entry — get_storey() still runs first and wins when it
    finds something.

    instance_defs: id/applicationId -> Base map, e.g. collect_instance_definitions()
    merged with build_object_map() (same convention normalize.py already uses
    to resolve InstanceDefinitionProxy.objects string ids).
    """
    storeys: dict[str, str] = {}
    visited_ids: set[str] = set()

    def _walk(obj: Base, chain: list[str]):
        st = getattr(obj, "speckle_type", "") or ""
        if "InstanceProxy" in st and "DefinitionProxy" not in st:
            obj_id = str(getattr(obj, "id", "") or "")
            if not obj_id or obj_id in visited_ids:
                return
            visited_ids.add(obj_id)

            storey = next(
                (name for name in reversed(chain) if name and name.lower() not in _GENERIC_COLLECTION_NAMES),
                None,
            )
            if not storey:
                return

            definition_id = str(getattr(obj, "definitionId", "") or "")
            defn = instance_defs.get(definition_id) if definition_id else None
            for target_id in (getattr(defn, "objects", None) or []) if defn else []:
                resolved = instance_defs.get(str(target_id))
                key = str(getattr(resolved, "id", None) or target_id) if resolved else str(target_id)
                storeys.setdefault(key, storey)
            return

        if "Collection" in st or "Model" in st:
            name = getattr(obj, "name", None) or ""
            for child in (getattr(obj, "elements", None) or []):
                if isinstance(child, Base):
                    _walk(child, chain + [name])

    _walk(root, [])
    logger.info("collect_instance_storeys: resolved storeys for %d geometry objects", len(storeys))
    return storeys


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
