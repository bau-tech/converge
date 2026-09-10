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


# IFC spatial-structure classes. Speckle's own server-side IFC
# FileImportService (see collect_ifc_storey_collections' docstring) emits
# each of these TWICE: once as a `Collection`-typed node that carries the
# `elements`/`@elements` child list (correctly skipped by flatten_elements'
# `is_container` check below), and once more as a plain leaf DataObject
# "twin" with real Attributes/GlobalId/properties — representing the
# container ITSELF, not a physical BIM element. flatten_elements has no
# other way to tell that twin apart from a real element, so it was being
# counted as one: confirmed live on a self-hosted 2.31.14 instance, this
# spuriously inflated element_count by one row per storey/building/site,
# and — since Site/Building sit above any storey — created a bogus
# "Unassigned" Levels bucket that doesn't exist when the same file is
# imported through a converter that represents each entity once (e.g.
# app.speckle.systems' bundle-format importer: same source file, 20 real
# storeys and no Unassigned bucket, vs. 20 real storeys + Site/Building
# showing up as storey=None here). No physical element ever has one of
# these as its own `ifcType`, so this is safe to exclude unconditionally.
_IFC_SPATIAL_CONTAINER_TYPES = {"IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"}


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


# Relation types extracted into bim_relationships by db/insert.py's
# insert_bundle_relationships — object<->object only (object<->node relations
# like IN_SYSTEM/IN_GROUP have no bim_elements row to point at and are out of
# scope: bim_relationships references two elements, not an element and an
# abstract container). IN_ROOM and BOUNDS are the same semantic link from
# opposite ends of the spec's redundant pair — only IN_ROOM is extracted, to
# avoid writing the same containment twice under two names.
_BUNDLE_RELATION_TYPES = ("hosted_on", "connects_to", "in_assembly", "in_room")


def _relation_pairs(obj) -> list[tuple[object, str]]:
    """Every object<->object relation _full_projection/fetch_bundle_selection
    care about, for a single native ModelObject."""
    pairs: list[tuple[object, str]] = []
    host = obj.host
    if host is not None:
        pairs.append((host, "hosted_on"))
    for connected in obj.connected_to:
        pairs.append((connected, "connects_to"))
    assembly = obj.assembly
    if assembly is not None:
        pairs.append((assembly, "in_assembly"))
    room = obj.room
    if room is not None:
        pairs.append((room, "in_room"))
    return pairs


def _merged_properties(obj) -> dict:
    """Type properties overlaid by instance properties, as nested dicts —
    local reimplementation of specklepy.bundle.base_projection's private
    _merged_properties/_overlay (not imported directly: that module is
    third-party-internal, and this is ~10 lines)."""
    merged = obj.type_properties.to_nested()
    _overlay_nested(merged, obj.properties.to_nested())
    return merged


def _overlay_nested(target: dict, source: dict) -> None:
    for key, value in source.items():
        existing = target.get(key)
        if isinstance(value, dict) and isinstance(existing, dict):
            _overlay_nested(existing, value)
        else:
            target[key] = value


def _full_projection(model) -> tuple[Base, list[tuple[str, str, str]]]:
    """
    Project a received bundle Model onto a classic Base tree — like
    Model.to_base(), but building one leaf DataObject per PHYSICAL OBJECT
    that has geometry, not one per unique geometry/instance-definition.

    Verified live against the real Snowdon Towers bundle commit: to_base()'s
    _attach_instance_definitions emits exactly one synthetic geometry object
    per unique instance DEFINITION (i.e. per shared mesh), regardless of how
    many physically distinct objects place that definition — of 917 real
    IfcBeam objects in that model (most reusing a handful of standard
    profiles), to_base()'s classic tree only ever surfaced 287 leaves; non-
    instanced categories in the same model (Walls/Slabs/Footings/Spaces)
    were completely unaffected and matched 1:1, confirming this is
    specifically an instance-collapsing gap in to_base(), not a general
    ingest bug. This function iterates model.objects instead — one row per
    real object regardless of how many others share its definition — and
    applies each object's own resolved instance transform (ModelGeometry.
    transform, composed through the full instance/definition chain by
    ModelObject.geometries) to the decoded local-space mesh, using the same
    _apply_transform_matrix ifc/geometry.py already relies on for Revit v3's
    analogous InstanceProxy+InstanceDefinitionProxy case — confirmed live
    that the shared local mesh genuinely needs this: two beams sharing one
    geometry_k had identical raw (untransformed) bbox centers but different
    transforms (different floor heights), and to_base() never applies it at
    all for its own synthetic members (unlike its InstanceProxy branch,
    which does — that branch just isn't what backs the elements themselves
    here, since _should_skip() drops InstanceProxy nodes from flatten_
    elements entirely).

    Also bakes level/ifcType/category directly onto each leaf as real
    attributes (get_storey()/classify_element() already know how to read
    them: obj.level, obj.type/obj.ifcType — see ifc/spatial.py and ifc/
    classify.py's IFC path) rather than returning them via a side channel
    like the previous version of this function did. The one thing that
    still needs a side channel is object<->object relations (HOSTED_ON/
    CONNECTS_TO/IN_ASSEMBLY/IN_ROOM), which don't have a natural single-
    object attribute to live on.

    Trade-offs, deliberately out of scope for this fix: no collection/
    storey hierarchy (every leaf goes straight under one flat root —
    flatten_elements doesn't need it: the Revit-category-hint mechanism it
    exists for doesn't apply to IFC-sourced bundles, gated on the caller
    only using this for is_bundle commits) and no renderMaterialProxies
    (materials aren't attached to the projected tree, unlike to_base() —
    affects viewer-bridge's visual appearance, not ingested data).

    Returns (root, relations) — relations is a list of (from_application_id,
    to_application_id, relation_type) triples, relation_type one of
    _BUNDLE_RELATION_TYPES.
    """
    from specklepy.bundle import sgeo
    from specklepy.objects.data_objects import DataObject
    from specklepy.objects.models.collections.collection import Collection
    from ifc.geometry import _apply_transform_matrix

    root = Collection(name="Received model", applicationId="artifact-root")
    root.id = "artifact-root"
    root["units"] = model.units
    root["version"] = 4

    relations: list[tuple[str, str, str]] = []

    for obj in model.objects:
        geometries = obj.geometries
        if not geometries:
            continue

        displays = []
        for g in geometries:
            if not g.is_sgeo:
                continue
            decoded = sgeo.decode(g.content)
            if g.transform is not None:
                verts = getattr(decoded, "vertices", None)
                if verts:
                    decoded.vertices = _apply_transform_matrix(list(verts), g.transform)
            decoded.applicationId = obj.application_id
            displays.append(decoded)
        if not displays:
            continue

        data_obj = DataObject(
            name=obj.name or obj.application_id,
            displayValue=displays,
            properties=_merged_properties(obj),
        )
        data_obj.applicationId = data_obj.id = obj.application_id
        data_obj["units"] = model.units

        level = obj.level
        if level is not None and level.name:
            data_obj["level"] = level.name
        ifc_type = obj.root_properties.get_string("ifcType")
        if ifc_type:
            data_obj["ifcType"] = ifc_type
        category = obj.root_properties.get_string("category")
        if category:
            data_obj["category"] = category

        root.elements.append(data_obj)

        for related, relation_type in _relation_pairs(obj):
            relations.append((obj.application_id, related.application_id, relation_type))

    return root, relations


def _fetch_bundle(obj_id: str, transport: ServerTransport) -> tuple[Base, list[tuple[str, str, str]]]:
    """Native-receive + project a bundle-format commit. See _full_projection's
    docstring for why this replaced calling Model.to_base() directly."""
    from specklepy.bundle.download import BundleReference

    parsed = BundleReference.parse(obj_id)
    account = transport.account
    if account is None:
        raise ValueError("bundle receive requires an authenticated ServerTransport (transport.account is None)")

    with operations.receive3(account, parsed.project_id, parsed.model_id, parsed.version_id) as model:
        return _full_projection(model)


def fetch_bundle_selection(obj_id: str, transport: ServerTransport, id_set: set[str]) -> tuple[list[dict], str]:
    """
    Native-Model extraction for speckle/publish.py's native bundle-authoring
    path (used by filter_and_publish when the source commit is bundle-format,
    to republish a filtered selection as a bundle version instead of a
    classic commit): for exactly the leaf ids in id_set — now simply each
    object's own applicationId, since _full_projection no longer produces
    any other kind of id — return one dict per surviving bundle object,
    carrying everything needed to author a new bundle. Geometry is passed
    through byte-for-byte (BundleObject.add_raw_geometry, no SGEO re-encode)
    rather than via the classic Base tree.

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
            key = obj.application_id
            if key not in id_set:
                continue
            geometries = obj.geometries
            if not geometries:
                continue

            level = obj.level
            material = obj.material
            if material is None:
                for g in geometries:
                    if g.effective_material is not None:
                        material = g.effective_material
                        break

            units.append({
                "key": key,
                "geometries": [(g.content, g.type) for g in geometries],
                "name": obj.name,
                "ifc_type": obj.root_properties.get_string("ifcType"),
                "category": obj.root_properties.get_string("category"),
                "properties": obj.properties.to_nested(),
                "level_name": level.name if (level is not None and level.name) else None,
                "level_elevation": level.elevation if level is not None else None,
                "material_argb": material.argb if material is not None else None,
            })

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
        "bundle_relations":   [],
    }

    client = get_client(server_url=srv, token=tok)
    transport = ServerTransport(client=client, stream_id=stream_id)

    if meta["is_bundle"]:
        try:
            root, meta["bundle_relations"] = _fetch_bundle(obj_id, transport)
        except Exception as exc:
            logger.warning(
                "Native bundle receive (receive3) failed for commit %s (%s: %s) — "
                "falling back to the classic receive()->to_base() shim. Geometry is "
                "unaffected, but any instanced elements sharing a definition will "
                "collapse to a single element, and level/ifcType/relations will be "
                "lost for this ingest (see _full_projection's docstring).",
                commit_id, type(exc).__name__, exc,
            )
            root = operations.receive(obj_id=obj_id, remote_transport=transport, local_transport=None)
        logger.info("Received bundle commit %s from stream %s (%d elements projected)",
                    commit_id, stream_id, len(getattr(root, "elements", None) or []))
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

    Falls back to find_original_ifc_blob()'s stream-wide guess in two cases:
    the fileUploads lookup itself is unavailable (older/newer Speckle server
    schema variance, network error), or fileUploads comes back an empty list
    (confirmed on app.speckle.systems: a stream can have a genuine, fully
    uploaded .ifc blob — e.g. from a non-web-UI ingest path such as a script
    using the ifcopenshell converter — while fileUploads stays permanently
    empty, because that server never wrote a convertedCommitId record for
    it; self-hosted Speckle does populate it for every web-UI upload). In
    both cases we have no signal either way, so it's worth a guess — but
    only when unambiguous: find_original_ifc_blob_for_stream_unambiguous()
    only returns a blob when every complete .ifc blob on the stream shares
    the same filename, so there's nothing to guess between.

    When fileUploads is non-empty but simply has no entry for this specific
    commit_id, that IS a definitive answer (this commit came from a
    connector push, not a file upload) — stays conservative and returns
    None rather than guessing. This is the scenario that mattered originally:
    guessing the largest .ifc blob anywhere on a stream previously returned
    a completely unrelated model's IFC file (mismatched element counts, no
    overlap with the model's own stored IfcGUID parameters) on a stream with
    multiple unrelated .ifc uploads. Callers (resolve_model_ifc_bytes)
    already treat None as "fall back to bim-normalizer's own synthetic
    export", which is guaranteed to actually be this model's geometry.
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
        if uploads:
            logger.info(
                "No file-upload matched commit %s on stream %s — this commit has no "
                "corresponding original IFC (likely a connector push, not a file "
                "upload); using bim-normalizer's synthetic export instead of "
                "guessing at an unrelated blob",
                commit_id, stream_id,
            )
            return None
        logger.info(
            "Stream %s reports no fileUploads at all (server doesn't track "
            "convertedCommitId for this ingest path) — trying an unambiguous "
            "stream-wide guess for commit %s",
            stream_id, commit_id,
        )
        return find_original_ifc_blob_for_stream_unambiguous(stream_id, tok, srv)
    except Exception as exc:
        logger.info(
            "fileUploads lookup unavailable for stream %s (%s) — falling back to unambiguous stream-wide guess",
            stream_id, exc,
        )
        return find_original_ifc_blob_for_stream_unambiguous(stream_id, tok, srv)


def find_original_ifc_blob_for_stream_unambiguous(
    stream_id: str,
    token: str | None = None,
    server_url: str | None = None,
) -> dict | None:
    """
    Like find_original_ifc_blob(), but only returns a blob when every
    successfully-uploaded .ifc blob on the stream shares the same filename —
    i.e. there is nothing to guess between. Used as a fallback when we have
    no fileUploads/convertedCommitId signal at all (see
    find_original_ifc_blob_for_commit's docstring): a single distinct
    filename repeated across blob entries (e.g. re-uploaded/reprocessed) is
    safe to treat as this stream's one original IFC, but streams that have
    ever held multiple different original files stay ambiguous and fall
    back to the synthetic export, same as before.
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
    ifc_blobs = [
        b for b in items if b.get("uploadStatus") == 1 and b.get("fileName", "").lower().endswith(".ifc")
    ]
    if not ifc_blobs:
        return None

    distinct_names = {b["fileName"] for b in ifc_blobs}
    if len(distinct_names) != 1:
        logger.info(
            "Stream %s has %d distinct .ifc blob filenames with no commit tracking — "
            "ambiguous, refusing to guess",
            stream_id, len(distinct_names),
        )
        return None

    blob = max(ifc_blobs, key=lambda b: b.get("fileSize", 0))
    return {
        "server_url": srv,
        "token": tok,
        "blob_id": blob["id"],
        "filename": blob["fileName"],
        "file_size": blob.get("fileSize"),
    }


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
            if getattr(child, "ifcType", None) not in _IFC_SPATIAL_CONTAINER_TYPES:
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


def collect_ifc_storey_collections(root: Base) -> dict[str, str]:
    """
    Best-effort storey lookup for Speckle's own server-side IFC
    FileImportService (confirmed on a self-hosted 2.31.14 instance, classic
    non-bundle commit): it encodes the IFC spatial structure (IfcProject >
    IfcSite > IfcBuilding > IfcBuildingStorey > elements) as nested
    `Objects.Data.Collection` nodes, each carrying the real IFC entity type
    on its own `.ifcType` attribute (e.g. "IfcBuildingStorey") — unlike
    Revit connector output, leaf elements here have no `.level` attribute
    of their own, so get_storey() finds nothing and every element collapses
    into a single (None) storey bucket.

    flatten_elements()'s existing category_hint promotion can't be reused
    for this: it only promotes a Collection's name when that name happens
    to match a Revit category in _REVIT_CATEGORY_MAP (e.g. a storey
    literally named "Parking" false-positives as the "Parking" Revit
    category; most real storey names, e.g. "L5", don't match anything and
    get silently dropped). This walks the same Collection tree
    independently, keyed off `ifcType == "IfcBuildingStorey"` instead, which
    correctly identifies a storey regardless of what it's named.

    Returns {} for any source without Collection nodes carrying `ifcType`
    (Revit/Tekla output), so this is purely additive — see normalize.py's
    `get_storey(obj) or instance_storeys.get(...) or ifc_storeys.get(...)`;
    a real `.level` attribute still wins whenever present.
    """
    storeys: dict[str, str] = {}
    visited_ids: set[str] = set()

    def _walk(obj: Base, current_storey: str | None):
        for child in (_child_elements(obj) or []):
            if not isinstance(child, Base):
                continue

            child_id = str(getattr(child, "id", "") or "")
            if child_id:
                if child_id in visited_ids:
                    continue
                visited_ids.add(child_id)

            st = getattr(child, "speckle_type", "") or ""
            if _should_skip(st):
                continue

            is_container = "Collection" in st or "Model" in st or "Folder" in st
            if is_container:
                next_storey = current_storey
                if getattr(child, "ifcType", None) == "IfcBuildingStorey":
                    name = getattr(child, "name", None)
                    if name:
                        next_storey = str(name).strip()
                _walk(child, next_storey)
            else:
                if current_storey and child_id:
                    storeys[child_id] = current_storey
                if _child_elements(child):
                    _walk(child, current_storey)

    _walk(root, None)
    logger.info("collect_ifc_storey_collections: resolved storeys for %d objects", len(storeys))
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


def list_project_models_and_versions(
    stream_id: str,
    token: str | None = None,
    server_url: str | None = None,
    max_versions_per_model: int | None = None,
) -> list[dict]:
    """
    Enumerate every model (branch) in a project and every version (commit)
    on each, for speckle/publish.py's copy_project_to_server(). Paginates
    both connections properly (Stream.branches/Branch.commits both take
    limit+cursor — confirmed live via schema introspection against a
    2.31.14 server; unlike converge_mcp.py's speckle_list_models/
    speckle_list_versions, which only fetch one unpaginated page and don't
    request referencedObject at all, neither of which is enough to actually
    replay a project's contents onto another server).

    Returns [{branch_name, branch_description, versions: [{id,
    referencedObject, message, sourceApplication, authorName, createdAt},
    ...]}, ...] — versions ordered oldest-to-newest (the GraphQL API
    returns newest-first; reversed here so a caller replaying history
    creates commits in the order they were originally authored).

    max_versions_per_model: keep only the N most recent versions per model
    (still returned oldest-first) — pass 1 for "latest version only", the
    common case for a project migration that doesn't need full history.
    """
    tok = token or settings.SPECKLE_TOKEN
    srv = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")

    branches: list[dict] = []
    cursor = None
    while True:
        data = _gql_request(srv, tok, """
            query($id: String!, $cursor: String) {
                stream(id: $id) {
                    branches(limit: 25, cursor: $cursor) {
                        cursor
                        items { name description }
                    }
                }
            }
        """, {"id": stream_id, "cursor": cursor})
        stream = data.get("stream")
        if stream is None:
            raise ValueError(f"Project {stream_id} not found on {srv}")
        conn = stream["branches"]
        items = conn.get("items") or []
        branches.extend(items)
        cursor = conn.get("cursor")
        if not cursor or not items:
            break

    result = []
    for branch in branches:
        name = branch["name"]
        versions: list[dict] = []
        vcursor = None
        while True:
            data = _gql_request(srv, tok, """
                query($id: String!, $name: String!, $cursor: String) {
                    stream(id: $id) {
                        branch(name: $name) {
                            commits(limit: 25, cursor: $cursor) {
                                cursor
                                items {
                                    id referencedObject message
                                    sourceApplication authorName createdAt
                                }
                            }
                        }
                    }
                }
            """, {"id": stream_id, "name": name, "cursor": vcursor})
            branch_data = data["stream"]["branch"]
            if branch_data is None:
                break
            conn = branch_data["commits"]
            items = conn.get("items") or []
            versions.extend(items)
            vcursor = conn.get("cursor")
            if not vcursor or not items:
                break
            if max_versions_per_model and len(versions) >= max_versions_per_model:
                break
        versions.reverse()
        if max_versions_per_model:
            versions = versions[-max_versions_per_model:]
        result.append({
            "branch_name": name,
            "branch_description": branch.get("description"),
            "versions": versions,
        })
    return result
