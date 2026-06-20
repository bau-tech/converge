"""
Speckle IFC MCP server
======================
A single MCP server combining:

  IFC tools  (ifcopenshell in-memory session)
    ifc_new / ifc_load / ifc_reset / ifc_save
    ifc_summary / ifc_tree / ifc_info / ifc_select / ifc_relations / ifc_materials

  Speckle server tools  (GraphQL → https://speckle.example.com)
    speckle_list_projects / speckle_list_models / speckle_list_versions

  Normalizer tools  (REST API at NORMALIZER_URL)
    speckle_list_ingested / speckle_get_summary / speckle_query_elements
    speckle_ingest / speckle_load   ← bridge: export IFC then load into memory
    speckle_filter_publish          ← filter elements → new Speckle commit/version

  Intelligence tools
    speckle_get_object          raw Speckle object properties (streaming, first object only)
    speckle_element_detail      full element: geometry quantities + all parameter sets
    speckle_diff_models         added/removed/changed elements + per-category deltas
    speckle_qa_check            0-1 quality score: names, storeys, geometry, materials, duplicates
    speckle_compare_categories  side-by-side category table for up to 6 models
    speckle_find_element        name search across all ingested models

  ifc5d / 5D quantity tools  (cost estimation & Bill of Quantities)
    ifc5d_quantities            IfcElementQuantity takeoff from the loaded IFC (volume/area per group)
    ifc5d_cost_schedule         IfcCostSchedule + IfcCostItem hierarchy from the loaded IFC
    ifc5d_boq_export            export BoQ to ODS (via ifc5d) or CSV fallback
    speckle_quantities          DB-backed quantity takeoff — no IFC load needed

Configuration (env or .env file next to this script):
  SPECKLE_SERVER_URL  default https://speckle.example.com   (also set in .mcp.json)
  SPECKLE_TOKEN       personal access token                 (loaded from .env)
  NORMALIZER_URL      default http://localhost:8002         (also set in .mcp.json)
"""

import json
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

# Load .env from this file's directory so the server works outside the Docker
# environment without manual env setup.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass

try:
    import ifcopenshell
    import ifcopenshell.util.element as ifc_util
except ImportError:
    print("ifcopenshell not installed. Run: pip install ifcopenshell", file=sys.stderr)
    sys.exit(1)

try:
    import ifc5d  # noqa: F401
    try:
        from ifc5d.ifc5Dspreadsheet import Ifc5DOdsWriter as _Ifc5DOdsWriter
    except ImportError:
        _Ifc5DOdsWriter = None
    _IFC5D_AVAILABLE = True
except ImportError:
    _IFC5D_AVAILABLE = False
    _Ifc5DOdsWriter = None

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print("mcp package not installed. Run: pip install 'mcp[cli]'", file=sys.stderr)
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────
_SPECKLE_URL = os.getenv("SPECKLE_SERVER_URL", "https://speckle.example.com").rstrip("/")
_SPECKLE_TOKEN = os.getenv("SPECKLE_TOKEN", "")
_NORMALIZER_URL = os.getenv("NORMALIZER_URL", "http://localhost:8002").rstrip("/")
# Empty string disables auth (safe for stdio; always set a key for streamable-http/SSE/remote)
_MCP_API_KEY = os.getenv("MCP_API_KEY", "")

mcp = FastMCP("speckle-ifc")

# ── In-memory IFC model state ─────────────────────────────────────────────────
# NOTE: in streamable-http/SSE remote mode all clients share a single Python process and
# therefore share these globals. _model_lock serialises writes to prevent data races, but
# two clients loading different models will still clobber each other. For multi-user remote
# deployments, wrap this server behind a session-aware proxy or use stdio mode.
_model: "ifcopenshell.file | None" = None
_model_source: str = ""    # path or "speckle:model_id"
_tmp_path: str | None = None  # temp IFC written by speckle_load; cleaned up on reset
_model_lock = threading.RLock()  # guards all writes to the three globals above


def _require_model() -> "ifcopenshell.file":
    with _model_lock:
        if _model is None:
            raise ValueError(
                "No IFC model loaded. "
                "Call ifc_load(path) to load a file, or speckle_load(model_id) "
                "to export and load a model from the Speckle normalizer."
            )
        return _model


# ── Internal helpers ──────────────────────────────────────────────────────────
def _gql(query: str, variables: dict | None = None, _retries: int = 2) -> dict:
    if not _SPECKLE_TOKEN:
        raise ValueError("SPECKLE_TOKEN is not set.")
    last_err: Exception | None = None
    for attempt in range(_retries + 1):
        try:
            resp = requests.post(
                f"{_SPECKLE_URL}/graphql",
                json={"query": query, "variables": variables or {}},
                headers={"Authorization": f"Bearer {_SPECKLE_TOKEN}", "Content-Type": "application/json"},
                timeout=30,
            )
            resp.raise_for_status()
            body = resp.json()
            if "errors" in body:
                raise ValueError(f"GraphQL errors: {body['errors']}")
            return body["data"]
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_err = exc
            if attempt < _retries:
                time.sleep(2 ** attempt)
    raise last_err  # type: ignore[misc]


def _download_original_ifc_blob(stream_id: str) -> bytes | None:
    """
    Query the Speckle server for IFC blobs on a stream and return the raw bytes
    of the most recent successfully uploaded one.  Returns None if none found.
    """
    if not _SPECKLE_TOKEN:
        return None
    try:
        data = _gql("""
            query($id: String!) {
                stream(id: $id) {
                    blobs(limit: 25) {
                        items { id fileName fileSize uploadStatus }
                    }
                }
            }
        """, {"id": stream_id})
        blobs = sorted(
            (
                b for b in (data.get("stream") or {}).get("blobs", {}).get("items", [])
                if b.get("uploadStatus") == 1 and b.get("fileName", "").lower().endswith(".ifc")
            ),
            key=lambda b: b.get("fileSize", 0),
            reverse=True,  # largest file first — most likely the complete original IFC
        )
        if not blobs:
            return None
        blob_id = blobs[0]["id"]
        resp = requests.get(
            f"{_SPECKLE_URL}/api/stream/{stream_id}/blob/{blob_id}",
            headers={"Authorization": f"Bearer {_SPECKLE_TOKEN}"},
            timeout=120,
        )
        resp.raise_for_status()
        return resp.content
    except Exception:
        return None


def _psets_for(model: "ifcopenshell.file", el: "ifcopenshell.entity_instance") -> dict:
    psets: dict[str, dict] = {}
    try:
        psets = ifc_util.get_psets(el)
    except Exception:
        # Fallback: traverse IsDefinedBy manually
        for rel in getattr(el, "IsDefinedBy", []):
            if rel.is_a("IfcRelDefinesByProperties"):
                pdef = rel.RelatingPropertyDefinition
                if pdef.is_a("IfcPropertySet"):
                    psets[pdef.Name] = {
                        p.Name: str(p.NominalValue) if hasattr(p, "NominalValue") else "?"
                        for p in pdef.HasProperties
                        if hasattr(p, "Name")
                    }
    return psets


def _tree_lines(model: "ifcopenshell.file", element, depth: int = 0) -> list[str]:
    name = getattr(element, "Name", None) or ""
    long = getattr(element, "LongName", None) or ""
    label = f"{name}  {long}".strip()
    lines = ["  " * depth + f"[#{element.id()}] {element.is_a()}  {label}"]
    for rel in model.by_type("IfcRelAggregates"):
        if rel.RelatingObject == element:
            for child in rel.RelatedObjects:
                lines.extend(_tree_lines(model, child, depth + 1))
    return lines


# ═════════════════════════════════════════════════════════════════════════════
# IFC SESSION TOOLS
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def ifc_new(schema: str = "IFC4") -> str:
    """Create a new empty in-memory IFC model."""
    global _model, _model_source
    with _model_lock:
        _model = ifcopenshell.file(schema=schema)
        _model_source = "new"
    return f"Created new empty {schema} model."


@mcp.tool()
def ifc_load(path: str) -> str:
    """Load an IFC file from disk into the in-memory model."""
    global _model, _model_source
    with _model_lock:
        try:
            m = ifcopenshell.open(path)
            _model = m
            _model_source = path
            count = len(list(m))
            return f"Loaded {path!r} — schema={m.schema}, {count} entities."
        except Exception:
            _model = None
            _model_source = ""
            raise


@mcp.tool()
def ifc_reset() -> str:
    """Unload the current in-memory model."""
    global _model, _model_source, _tmp_path
    with _model_lock:
        _model = None
        _model_source = ""
        if _tmp_path:
            try:
                os.unlink(_tmp_path)
            except OSError:
                pass
            _tmp_path = None
    return "Model unloaded."


@mcp.tool()
def ifc_save(path: str = "") -> str:
    """Save the in-memory model to disk. Uses the original load path if path is omitted."""
    with _model_lock:
        m = _require_model()
        target = path or (_model_source if _model_source and not _model_source.startswith("speckle:") else "")
        if not target:
            raise ValueError("Provide a path — model was not loaded from disk.")
        m.write(target)
    return f"Saved to {target!r}."


# ═════════════════════════════════════════════════════════════════════════════
# IFC QUERY TOOLS
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def ifc_summary() -> str:
    """Return schema, project metadata, and entity class counts for the loaded model."""
    m = _require_model()
    lines = [f"Source: {_model_source}", f"Schema: {m.schema}"]

    projects = m.by_type("IfcProject")
    if projects:
        p = projects[0]
        lines.append(f"Project name: {p.Name or '(unnamed)'}")
        if getattr(p, "LongName", None):
            lines.append(f"Long name: {p.LongName}")
        if getattr(p, "Description", None):
            lines.append(f"Description: {p.Description}")

    counts: dict[str, int] = {}
    for e in m:
        cls = e.is_a()
        counts[cls] = counts.get(cls, 0) + 1

    total = sum(counts.values())
    top = sorted(counts.items(), key=lambda x: -x[1])[:20]
    lines.append(f"\nTotal entities: {total}")
    lines.append("Top classes:")
    for cls, n in top:
        lines.append(f"  {cls}: {n}")
    return "\n".join(lines)


@mcp.tool()
def ifc_tree() -> str:
    """Return the spatial hierarchy: Project → Site → Building → Storey → Space."""
    m = _require_model()
    out: list[str] = []
    for project in m.by_type("IfcProject"):
        out.extend(_tree_lines(m, project))
    return "\n".join(out) if out else "No spatial structure found."


@mcp.tool()
def ifc_info(element_id: int) -> str:
    """Return all attributes and property sets of a single element by its STEP id."""
    m = _require_model()
    try:
        el = m.by_id(element_id)
    except Exception:
        return f"No entity with id #{element_id}."

    lines = [f"#{el.id()} {el.is_a()}"]
    for i in range(len(el)):
        try:
            name = el.attribute_name(i)
            val = el[i]
            if val is not None:
                lines.append(f"  {name} = {str(val)[:200]}")
        except Exception:
            pass

    psets = _psets_for(m, el)
    if psets:
        lines.append("\nProperty sets:")
        for pset_name, props in psets.items():
            lines.append(f"  {pset_name}:")
            for k, v in props.items():
                lines.append(f"    {k}: {v}")
    return "\n".join(lines)


@mcp.tool()
def ifc_select(ifc_class: str, limit: int = 100) -> str:
    """Return all elements of a given IFC class (e.g. IfcWall, IfcBeam)."""
    m = _require_model()
    try:
        elements = m.by_type(ifc_class)
    except Exception as e:
        return f"Error: {e}"
    # Build storey index once — O(relations) instead of O(elements × relations)
    storey_of: dict[int, str] = {}
    for rel in m.by_type("IfcRelContainedInSpatialStructure"):
        sname = getattr(rel.RelatingStructure, "Name", "") or ""
        for member in (rel.RelatedElements or []):
            storey_of[member.id()] = sname

    lines = [f"{len(elements)} {ifc_class} element(s):"]
    for el in elements[:limit]:
        name = getattr(el, "Name", None) or ""
        lines.append(f"  #{el.id()}  {name}  {storey_of.get(el.id(), '')}")
    if len(elements) > limit:
        lines.append(f"  ... and {len(elements) - limit} more (increase limit)")
    return "\n".join(lines)


@mcp.tool()
def ifc_relations(element_id: int) -> str:
    """Return all relationships an element participates in."""
    m = _require_model()
    try:
        el = m.by_id(element_id)
    except Exception:
        return f"No entity #{element_id}."

    lines = [f"#{el.id()} {el.is_a()}  '{getattr(el, 'Name', '')}'"]

    # Forward attributes that reference other entities
    for attr in el.attribute_names():
        try:
            val = getattr(el, attr)
        except Exception:
            continue
        if not hasattr(val, "__iter__") or isinstance(val, str):
            continue
        items = [v for v in val if hasattr(v, "is_a")][:5]
        if items:
            refs = [f"#{i.id()} {i.is_a()}" for i in items]
            lines.append(f"  {attr}: {refs}")

    # Spatial containment
    for rel in m.by_type("IfcRelContainedInSpatialStructure"):
        if el in rel.RelatedElements:
            s = rel.RelatingStructure
            lines.append(f"  ContainedIn: #{s.id()} {s.is_a()} '{getattr(s,'Name','')}'")

    return "\n".join(lines)


@mcp.tool()
def ifc_materials() -> str:
    """List all material definitions in the loaded model."""
    m = _require_model()
    mats = m.by_type("IfcMaterial")
    lines = [f"{len(mats)} material(s):"]
    for mat in mats:
        lines.append(f"  {mat.Name or '(unnamed)'}")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# SPECKLE SERVER TOOLS  (GraphQL)
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def speckle_list_projects(limit: int = 25) -> str:
    """List projects on our Speckle server (https://speckle.example.com)."""
    data = _gql("""
        query($limit: Int!) {
            streams(limit: $limit) {
                items { id name description updatedAt }
            }
        }
    """, {"limit": limit})
    items = data["streams"]["items"]
    lines = [f"{len(items)} project(s) on {_SPECKLE_URL}:"]
    for p in items:
        updated = (p.get("updatedAt") or "")[:10]
        desc = (p.get("description") or "").strip()
        lines.append(f"  {p['id']}  {p['name']}  {updated}  {desc}")
    return "\n".join(lines)


@mcp.tool()
def speckle_list_models(project_id: str) -> str:
    """List models (branches) in a Speckle project."""
    data = _gql("""
        query($id: String!) {
            stream(id: $id) {
                name
                branches { items { id name description } }
            }
        }
    """, {"id": project_id})
    stream = data["stream"]
    branches = stream["branches"]["items"]
    lines = [f"Project '{stream['name']}' — {len(branches)} model(s):"]
    for b in branches:
        desc = (b.get("description") or "").strip()
        lines.append(f"  name={b['name']}  {desc}")
    return "\n".join(lines)


@mcp.tool()
def speckle_list_versions(project_id: str, model_name: str, limit: int = 10) -> str:
    """List recent versions (commits) of a model. model_name is the branch name."""
    data = _gql("""
        query($streamId: String!, $branchName: String!, $limit: Int!) {
            stream(id: $streamId) {
                branch(name: $branchName) {
                    commits(limit: $limit) {
                        items {
                            id message sourceApplication authorName createdAt
                        }
                    }
                }
            }
        }
    """, {"streamId": project_id, "branchName": model_name, "limit": limit})
    commits = data["stream"]["branch"]["commits"]["items"]
    lines = [f"{len(commits)} version(s) of '{model_name}':"]
    for c in commits:
        src = (c.get("sourceApplication") or "").strip()
        msg = (c.get("message") or "").strip()
        created = (c.get("createdAt") or "")[:10]
        lines.append(f"  commit_id={c['id']}  {created}  {src}  {msg}")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# NORMALIZER TOOLS  (REST API)
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def speckle_list_ingested() -> str:
    """
    List all BIM models already normalized and stored in our PostgreSQL database.
    Returns model_id for each model.
    → use model_id with: speckle_get_summary, speckle_query_elements,
      speckle_query_by_parameter, speckle_quantities, speckle_load, speckle_qa_check
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models", timeout=30)
    resp.raise_for_status()
    models = resp.json()
    if not models:
        return "No models ingested yet. Use speckle_ingest(stream_id, commit_id) to add one."
    lines = [f"{len(models)} ingested model(s):"]
    for m in models:
        ingested = str(m.get("ingested_at") or "")[:10]
        lines.append(
            f"  model_id={m['model_id']}\n"
            f"    stream={m['stream_id']}  branch={m.get('branch_name', '')}\n"
            f"    source={m.get('source', '')}  elements={m.get('element_count', 0)}"
            f"  ingested={ingested}"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_get_summary(model_id: str) -> str:
    """Return category / IFC class / storey distributions for a normalized model."""
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/summary", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Run speckle_list_ingested() to see available models."
    resp.raise_for_status()
    data = resp.json()
    lines = [f"Summary for model {model_id}:"]
    for section, rows in data.items():
        if isinstance(rows, list) and rows:
            lines.append(f"\n{section}:")
            for row in rows[:20]:
                if isinstance(row, dict):
                    lines.append("  " + "  ".join(f"{k}={v}" for k, v in row.items()))
                else:
                    lines.append(f"  {row}")
    return "\n".join(lines)


@mcp.tool()
def speckle_query_elements(
    model_id: str,
    category: str = "",
    ifc_class: str = "",
    storey: str = "",
    limit: int = 50,
) -> str:
    """
    Query normalized elements from the database with optional filters.
    Returns element_id, ifc_class, category, name, storey, speckle_id.
    Use speckle_list_ingested() to find valid model_id values.
    For parameter-value filtering use speckle_query_by_parameter() instead.
    → feeds: speckle_element_detail(element_id)
    """
    params: dict = {"limit": limit}
    if category:
        params["category"] = category
    if ifc_class:
        params["ifc_class"] = ifc_class
    if storey:
        params["storey"] = storey

    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/elements", params=params, timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found."
    resp.raise_for_status()
    elements = resp.json()

    lines = [f"{len(elements)} element(s) (limit={limit}):"]
    for e in elements:
        lines.append(
            f"  [{e['ifc_class']}] {e.get('name') or '(unnamed)'}"
            f"  storey={e.get('storey') or '?'}"
            f"  speckle_id={e.get('speckle_id') or ''}"
            f"  element_id={e.get('element_id') or ''}"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_ingest(stream_id: str, commit_id: str) -> str:
    """
    Ingest a Speckle commit into the normalizer (fetch → classify → store in PostgreSQL).
    Waits for completion (up to 10 min). Returns MODEL_ID on success.
    Get stream_id and commit_id from speckle_list_projects / speckle_list_versions.
    → after success, use MODEL_ID with: speckle_load, speckle_query_elements, speckle_get_summary
    """
    resp = requests.post(
        f"{_NORMALIZER_URL}/ingest",
        json={"stream_id": stream_id, "commit_id": commit_id},
        timeout=30,
    )
    resp.raise_for_status()
    result = resp.json()

    if result.get("status") == "complete":
        mid = result["model_id"]
        return (
            f"Already ingested.\n"
            f"MODEL_ID: {mid}\n"
            f"Elements: {result.get('element_count', 0)}\n"
            f"Use speckle_load('{mid}') to load the IFC into memory."
        )

    job_id = result.get("job_id")
    if not job_id:
        return f"Unexpected response: {result}"

    # Poll up to 10 minutes; report elapsed time so the caller can track progress
    t0 = time.time()
    for attempt in range(120):
        time.sleep(5)
        poll = requests.get(f"{_NORMALIZER_URL}/ingest/status/{job_id}", timeout=15)
        poll.raise_for_status()
        status = poll.json()
        if status["status"] == "complete":
            mid = status["model_id"]
            elapsed = int(time.time() - t0)
            return (
                f"Ingested successfully (took {elapsed}s).\n"
                f"MODEL_ID: {mid}\n"
                f"Elements: {status.get('element_count', 0)}\n"
                f"Use speckle_load('{mid}') to load the IFC into memory."
            )
        if status["status"] == "failed":
            return f"Ingest failed: {status.get('error')}"

    return f"Timed out after 10 minutes waiting for ingest job {job_id}."


@mcp.tool()
def _build_ifc_subset(derived_model_id: str) -> str | None:
    """
    Build a filtered IFC from the in-memory source model containing only the elements
    present in derived_model_id. Returns a temp file path or None if not possible.

    Uses application_id (= IFC GlobalId for IFC-sourced models) to identify which
    IfcElement entities to keep. Falls back to None for Revit sources (no GlobalId match).
    """
    with _model_lock:
        source_model = _model
    if source_model is None:
        return None

    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{derived_model_id}/elements/flat",
        params={"limit": 999_999},
        timeout=60,
    )
    if resp.status_code != 200:
        return None
    elements = resp.json().get("elements", [])
    keep_ids = {e["application_id"] for e in elements if e.get("application_id")}
    if not keep_ids:
        return None

    # Write full source model → temp → reload → remove unwanted elements → save
    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False, dir=tempfile.gettempdir()) as f:
        tmp_path = f.name
    source_model.write(tmp_path)
    filtered = ifcopenshell.open(tmp_path)
    removed = 0
    for el in list(filtered.by_type("IfcElement")):
        if el.GlobalId not in keep_ids:
            filtered.remove(el)
            removed += 1
    if removed == 0:
        # No GlobalId match — source is probably not IFC; signal failure
        os.unlink(tmp_path)
        return None
    filtered.write(tmp_path)
    return tmp_path


def speckle_load(model_id: str, coord_unit: str = "mm") -> str:
    """
    Export a normalized model as IFC4X3 and load it into the in-memory IFC model.

    This is the bridge tool: it fetches the normalized data from PostgreSQL,
    exports a full IFC file via the normalizer, and loads it with ifcopenshell
    so all ifc_* tools (ifc_summary, ifc_tree, ifc_select, ifc_info, etc.)
    then operate on this model.

    coord_unit: 'mm' (default) or 'm' — controls IFC geometry coordinates.
    Use speckle_list_ingested() to find model_id values.
    """
    global _model, _model_source, _tmp_path

    # Evict any previous temp file before writing a new one
    with _model_lock:
        if _tmp_path:
            try:
                os.unlink(_tmp_path)
            except OSError:
                pass
            _tmp_path = None

    # Fetch model metadata so we know the source and stream_id
    meta_resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}", timeout=15)
    if meta_resp.status_code == 404:
        return f"Model {model_id} not found. Run speckle_list_ingested() to see available models."
    meta_resp.raise_for_status()
    meta = meta_resp.json()
    source = (meta.get("source") or "").lower()
    stream_id = meta.get("stream_id") or ""

    # If this model was produced by speckle_filter_publish its source is stored as
    # "filtered" in the normalizer DB — skip the stream blob (which would return the
    # full original IFC) and instead build a filtered IFC from the in-memory model.
    is_derived = source == "filtered"
    if is_derived:
        tmp_path = _build_ifc_subset(model_id)
        if tmp_path:
            m = ifcopenshell.open(tmp_path)
            with _model_lock:
                _tmp_path = tmp_path
                _model = m
                _model_source = f"speckle:{model_id}"
            count = len(list(m))
            elements = len(m.by_type("IfcElement"))
            return (
                f"Loaded filtered IFC built from source model — {elements} element(s).\n"
                f"  Schema: {m.schema}\n"
                f"  Total entities: {count}\n"
                f"  Temp file: {tmp_path}\n"
                f"You can now use ifc_summary(), ifc_tree(), ifc_select(), ifc_save(), etc."
            )
        # Source model not in memory (session restart) or not IFC — fall through to normalizer export

    # IFC source: try to serve the original file stored on the Speckle server.
    # Skipped for derived (filter-published) models even when source is not in memory,
    # so we don't accidentally serve the full original IFC for a filtered model.
    if not is_derived and "ifc" in source and stream_id:
        ifc_bytes = _download_original_ifc_blob(stream_id)
        if ifc_bytes:
            with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False, dir=tempfile.gettempdir()) as f:
                f.write(ifc_bytes)
                tmp_path = f.name
            m = ifcopenshell.open(tmp_path)
            with _model_lock:
                _tmp_path = tmp_path
                _model = m
                _model_source = f"speckle:{model_id}:original"
            count = len(list(m))
            elements = len(m.by_type("IfcElement"))
            return (
                f"Loaded ORIGINAL IFC from Speckle server (stream {stream_id}).\n"
                f"  Schema: {m.schema}\n"
                f"  Total entities: {count}\n"
                f"  IfcElement instances: {elements}\n"
                f"  Temp file: {tmp_path}\n"
                f"You can now use ifc_summary(), ifc_tree(), ifc_select(), etc."
            )
        # No blob found on Speckle — fall through to normalizer re-export

    # Start async export job
    resp = requests.post(
        f"{_NORMALIZER_URL}/models/{model_id}/export/ifc",
        params={"coord_unit": coord_unit},
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Run speckle_list_ingested() to see available models."
    resp.raise_for_status()
    job = resp.json()
    job_id = job["job_id"]

    # Poll for completion
    for _ in range(60):   # up to 3 minutes
        time.sleep(3)
        sr = requests.get(
            f"{_NORMALIZER_URL}/models/{model_id}/export/ifc/{job_id}/status",
            timeout=15,
        )
        sr.raise_for_status()
        s = sr.json()
        if s["status"] == "complete":
            break
        if s["status"] == "failed":
            return f"IFC export failed: {s.get('error')}"
    else:
        return "IFC export timed out after 3 minutes."

    # Download IFC bytes
    dl = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/export/ifc/{job_id}/download",
        timeout=120,
    )
    dl.raise_for_status()

    # Write to temp file (ifcopenshell.open requires a path)
    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False, dir=tempfile.gettempdir()) as f:
        f.write(dl.content)
        tmp_path = f.name

    m = ifcopenshell.open(tmp_path)
    with _model_lock:
        _tmp_path = tmp_path
        _model = m
        _model_source = f"speckle:{model_id}"

    count = len(list(m))
    elements = len(m.by_type("IfcElement"))
    return (
        f"Loaded model {model_id} into memory.\n"
        f"  Schema: {m.schema}\n"
        f"  Total entities: {count}\n"
        f"  IfcElement instances: {elements}\n"
        f"  Temp file: {tmp_path}\n"
        f"You can now use ifc_summary(), ifc_tree(), ifc_select('IfcWall'), etc."
    )


# ═════════════════════════════════════════════════════════════════════════════
# INTELLIGENCE TOOLS
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def speckle_get_object(stream_id: str, object_id: str) -> str:
    """
    Fetch a raw Speckle object and show its top-level properties.
    The object_id is the hash returned by speckle_list_versions (referencedObject).
    Only reads the first line of the JSONL response (the requested object itself),
    so large models are not fully downloaded.
    """
    if not _SPECKLE_TOKEN:
        raise ValueError("SPECKLE_TOKEN is not set.")
    with requests.get(
        f"{_SPECKLE_URL}/objects/{stream_id}/{object_id}",
        headers={"Authorization": f"Bearer {_SPECKLE_TOKEN}"},
        stream=True,
        timeout=30,
    ) as resp:
        resp.raise_for_status()
        first_line = next(
            (ln for ln in resp.iter_lines(decode_unicode=True) if ln), None
        )
    if not first_line:
        return "Empty response from Speckle object API."

    obj = json.loads(first_line)
    _SKIP = {"__closure", "__parents", "__tree", "id", "totalChildrenCount"}
    _LARGE = {"displayValue", "@displayValue", "vertices", "faces", "parameters"}

    lines = [
        f"Object {object_id[:12]}... in stream {stream_id}",
        f"  speckle_type: {obj.get('speckle_type', '?')}",
    ]
    for k, v in obj.items():
        if k in _SKIP or k.startswith("__"):
            continue
        if k in _LARGE:
            if isinstance(v, list):
                lines.append(f"  {k}: [{len(v)} items]")
            elif isinstance(v, dict):
                lines.append(f"  {k}: {{{len(v)} keys}}")
            else:
                lines.append(f"  {k}: [large value]")
            continue
        sv = str(v)
        lines.append(f"  {k}: {sv[:200]}{'...' if len(sv) > 200 else ''}")
    return "\n".join(lines)


@mcp.tool()
def speckle_element_detail(element_id: str) -> str:
    """
    Return full details for a single normalized element: geometry quantities
    (volume, area, centroid) and all stored parameters grouped by property set.
    Use the element_id UUID from speckle_query_elements() results.
    """
    resp = requests.get(f"{_NORMALIZER_URL}/elements/{element_id}", timeout=30)
    if resp.status_code == 404:
        return f"Element {element_id} not found. Use speckle_query_elements() to find element IDs."
    resp.raise_for_status()
    d = resp.json()

    lines = [
        f"Element {element_id}",
        f"  ifc_class:  {d.get('ifc_class', '')}",
        f"  category:   {d.get('category', '')}",
        f"  name:       {d.get('name', '')}",
        f"  storey:     {d.get('storey', '')}",
        f"  speckle_id: {d.get('speckle_id', '')}",
    ]
    if d.get("volume_m3") is not None:
        lines.append(f"  volume_m3:  {d['volume_m3']}")
    if d.get("area_m2") is not None:
        lines.append(f"  area_m2:    {d['area_m2']}")
    if d.get("centroid"):
        lines.append(f"  centroid:   {d['centroid']}")

    params = d.get("parameters", [])
    if params:
        pset_groups: dict = {}
        for p in params:
            pset_groups.setdefault(p.get("pset") or "General", []).append(p)
        lines.append(f"\nParameters ({len(params)} total):")
        for pset, ps in sorted(pset_groups.items()):
            lines.append(f"  [{pset}]")
            for p in ps:
                lines.append(f"    {p['key']}: {p['value']}")
    else:
        lines.append("\nNo parameters stored.")
    return "\n".join(lines)


@mcp.tool()
def speckle_diff_models(model_id_a: str, model_id_b: str) -> str:
    """
    Compare two normalized models. model_id_a = baseline (older), model_id_b = current (newer).
    Returns element counts (added / removed / changed), per-category deltas,
    and a sample of changed elements.
    Use speckle_list_ingested() to find model IDs.
    """
    resp = requests.get(f"{_NORMALIZER_URL}/diff/{model_id_a}/{model_id_b}", timeout=30)
    if resp.status_code == 404:
        return "One or both models not found. Use speckle_list_ingested() to verify model IDs."
    resp.raise_for_status()
    d = resp.json()

    delta = d.get("total_delta", 0)
    lines = [
        f"Model diff",
        f"  Baseline  ({model_id_a[:8]}...): {d.get('other_total', '?')} elements",
        f"  Current   ({model_id_b[:8]}...): {d.get('current_total', '?')} elements",
        f"  Net delta: {delta:+d}",
        "",
        f"  Added:    {d.get('added_count', 0)}",
        f"  Removed:  {d.get('removed_count', 0)}",
        f"  Changed:  {d.get('changed_count', 0)}",
    ]

    cat_changes = [c for c in d.get("category_changes", []) if c["delta"] != 0]
    if cat_changes:
        lines.append("\nCategory deltas (sorted by magnitude):")
        for c in sorted(cat_changes, key=lambda x: -abs(x["delta"]))[:20]:
            lines.append(
                f"  {c['category']:<38} {c['other_count']:>5} → {c['current_count']:>5}  ({c['delta']:+d})"
            )

    changed = d.get("changed_elements", [])
    if changed:
        n = min(5, len(changed))
        lines.append(f"\nSample changed elements ({n} of {len(changed)}):")
        for c in changed[:n]:
            lines.append(
                f"  [{c.get('category', '')}] {c.get('name', '')} — "
                f"speckle_id: {c.get('speckle_id_b', '')}"
            )

    return "\n".join(lines)


@mcp.tool()
def speckle_qa_check(model_id: str) -> str:
    """
    Run a BIM data-quality assessment on a normalized model and return a 0–1 score.

    Checks performed:
      • Unclassified elements (category = Generic Models / Unknown / NULL)
      • Elements without geometry (can't compute quantities)
      • Elements without names
      • Elements without storey assignment
      • Elements without any material parameter
      • Duplicate application IDs (data integrity)

    Each issue shows a count, percentage of total, and up to 3 sample Speckle IDs
    so you can inspect the affected objects in the Speckle viewer.
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/qa", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    d = resp.json()

    total = d.get("total_elements", 0)
    score = d.get("score", 0.0)
    filled = int(score * 20)
    bar = "█" * filled + "░" * (20 - filled)

    lines = [
        f"BIM Quality Report — {model_id[:8]}...",
        f"  Total elements: {total}",
        f"  Quality score:  {score:.1%}  [{bar}]",
        "",
        "Issues:",
    ]

    labels = {
        "unclassified":  ("Unclassified elements", 0.20),
        "no_geometry":   ("No geometry (quantities unavailable)", 0.25),
        "no_name":       ("Missing element names", 0.15),
        "no_storey":     ("No storey assignment", 0.15),
        "no_material":   ("No material parameter", 0.10),
        "duplicate_ids": ("Duplicate application IDs", 0.15),
    }
    issues = d.get("issues", {})
    for key, (label, weight) in labels.items():
        issue = issues.get(key, {})
        count = issue.get("count", 0)
        pct = f" ({count / total:.0%})" if total else ""
        icon = "✓" if count == 0 else "✗"
        lines.append(f"  {icon} {label}: {count}{pct}  [weight {weight:.0%}]")
        samples = issue.get("samples", [])
        if samples:
            lines.append(f"      Samples: {', '.join(str(s) for s in samples[:3])}")

    if score >= 0.9:
        lines.append("\nOverall: Excellent data quality.")
    elif score >= 0.75:
        lines.append("\nOverall: Good quality — minor issues.")
    elif score >= 0.5:
        lines.append("\nOverall: Moderate quality — review flagged issues.")
    else:
        lines.append("\nOverall: Poor quality — significant data gaps detected.")

    return "\n".join(lines)


@mcp.tool()
def speckle_compare_categories(model_ids: str) -> str:
    """
    Compare element counts per category across multiple normalized models side by side.
    model_ids: comma-separated list of model_id UUIDs (max 6).
    Example: speckle_compare_categories("abc-123,def-456")
    Use speckle_list_ingested() to find model_id values.
    → feeds: speckle_get_summary(model_id) for per-model details
    """
    ids = [m.strip() for m in model_ids.split(",") if m.strip()]
    if not ids:
        return "No model IDs provided. Pass a comma-separated list of model_id values."
    if len(ids) > 6:
        return f"Maximum 6 models for comparison — got {len(ids)}. Trim the list."

    summaries: dict = {}
    labels: dict = {}
    for mid in ids:
        resp = requests.get(f"{_NORMALIZER_URL}/models/{mid}/summary", timeout=30)
        if resp.status_code == 404:
            return f"Model {mid} not found. Use speckle_list_ingested() to verify."
        resp.raise_for_status()
        s = resp.json()
        summaries[mid] = s
        labels[mid] = s.get("branch_name") or mid[:8]

    all_cats: set[str] = set()
    for s in summaries.values():
        all_cats.update(k for k in s.get("by_category", {}) if k != "Unknown")

    cat_totals = {
        c: sum(summaries[m].get("by_category", {}).get(c, {}).get("count", 0) for m in ids)
        for c in all_cats
    }
    sorted_cats = sorted(all_cats, key=lambda c: -cat_totals[c])

    col = 10
    header = "  " + "".join(f"{labels[m]:>{col}}" for m in ids)
    lines = ["Category comparison:", header, "  " + "-" * (len(ids) * col + 38)]

    for cat in sorted_cats[:30]:
        row = "".join(
            f"{summaries[m].get('by_category', {}).get(cat, {}).get('count', 0):>{col}}"
            for m in ids
        )
        lines.append(f"  {cat:<38}{row}")

    totals_row = "".join(
        f"{summaries[m].get('total_count', 0):>{col}}" for m in ids
    )
    lines.append("  " + "-" * (len(ids) * col + 38))
    lines.append(f"  {'TOTAL':<38}{totals_row}")

    vol_row = "".join(
        f"{summaries[m].get('total_volume_m3', 0):>{col}.1f}" for m in ids
    )
    lines.append(f"  {'Volume m³':<38}{vol_row}")

    return "\n".join(lines)


@mcp.tool()
def speckle_find_element(query: str, model_id: str = "") -> str:
    """
    Search for elements by name (case-insensitive partial match) across all ingested models.
    If model_id is provided the search is limited to that model.
    Returns element_id, ifc_class, category, name, storey, and model.

    Examples:
      speckle_find_element("HEB 300")          — find all beams named HEB 300
      speckle_find_element("column", "abc-123") — columns in a specific model
    """
    if model_id:
        search_ids = [model_id]
    else:
        resp = requests.get(f"{_NORMALIZER_URL}/models", timeout=30)
        resp.raise_for_status()
        search_ids = [m["model_id"] for m in resp.json()]

    def _fetch_model(mid: str) -> list:
        try:
            r = requests.get(
                f"{_NORMALIZER_URL}/models/{mid}/elements",
                params={"name": query, "limit": 25},
                timeout=30,
            )
            if r.status_code == 200:
                return [{**e, "_model_id": mid} for e in r.json()]
        except Exception:
            pass
        return []

    results: list = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch_model, mid): mid for mid in search_ids[:10]}
        for fut in as_completed(futures):
            results.extend(fut.result())
            if len(results) >= 100:
                break

    if not results:
        return f"No elements matching '{query}' found across {len(search_ids)} model(s)."

    lines = [f"{len(results)} element(s) matching '{query}':"]
    for e in results[:30]:
        lines.append(
            f"  [{e.get('ifc_class', '?')}] {e.get('name', '(unnamed)')}"
            f"  storey={e.get('storey') or '?'}"
            f"  model={e.get('_model_id', '')[:8]}..."
            f"  element_id={e.get('element_id', '')}"
        )
    if len(results) > 30:
        lines.append(f"  ... and {len(results) - 30} more (narrow the query or specify model_id)")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# IFC5D / 5D QUANTITY TOOLS
# ═════════════════════════════════════════════════════════════════════════════

def _ifc_qty_by_element(m: "ifcopenshell.file") -> "dict[int, tuple[float, float]]":
    """Return {element_id: (volume_m3, area_m2)} from IfcElementQuantity sets."""
    el_qty: dict[int, tuple[float, float]] = {}
    for rel in m.by_type("IfcRelDefinesByProperties"):
        try:
            qset = rel.RelatingPropertyDefinition
        except Exception:
            continue
        if not qset.is_a("IfcElementQuantity"):
            continue
        vol, area = 0.0, 0.0
        for qty in (qset.Quantities or []):
            try:
                if qty.is_a("IfcQuantityVolume"):
                    vol += float(qty.VolumeValue or 0)
                elif qty.is_a("IfcQuantityArea"):
                    area += float(qty.AreaValue or 0)
            except Exception:
                pass
        for el in (rel.RelatedObjects or []):
            if not el.is_a("IfcElement"):
                continue
            eid = el.id()
            prev_v, prev_a = el_qty.get(eid, (0.0, 0.0))
            el_qty[eid] = (prev_v + vol, prev_a + area)
    return el_qty


def _ifc_storey_by_element(m: "ifcopenshell.file") -> "dict[int, str]":
    """Return {element_id: storey_name} from IfcRelContainedInSpatialStructure."""
    el_storey: dict[int, str] = {}
    for rel in m.by_type("IfcRelContainedInSpatialStructure"):
        sname = getattr(rel.RelatingStructure, "Name", None) or ""
        for el in (rel.RelatedElements or []):
            el_storey[el.id()] = sname
    return el_storey

@mcp.tool()
def ifc5d_quantities(group_by: str = "ifc_class") -> str:
    """
    Aggregate quantity takeoff from the loaded IFC model using IfcElementQuantity sets.
    Reads NetVolume and NetSideArea quantities attached to each IfcElement.

    group_by: 'ifc_class' (default), 'storey', or 'material'
    Returns element counts + total volume (m³) + total area (m²) per group.

    Requires a model loaded via ifc_load() or speckle_load().
    For DB-backed takeoff without loading IFC use speckle_quantities(model_id).
    """
    m = _require_model()

    el_qty = _ifc_qty_by_element(m)

    # Spatial containment cache for 'storey' grouping
    el_storey: dict[int, str] = {}
    if group_by == "storey":
        el_storey = _ifc_storey_by_element(m)

    # Material cache for 'material' grouping
    el_material: dict[int, str] = {}
    if group_by == "material":
        for rel in m.by_type("IfcRelAssociatesMaterial"):
            mat = rel.RelatingMaterial
            try:
                if mat.is_a("IfcMaterial"):
                    mname = mat.Name or "Unknown"
                elif mat.is_a("IfcMaterialList"):
                    mname = (mat.Materials[0].Name if mat.Materials else "Unknown")
                elif mat.is_a("IfcMaterialLayerSetUsage"):
                    layers = mat.ForLayerSet.MaterialLayers if mat.ForLayerSet else []
                    mname = layers[0].Material.Name if layers else "Unknown"
                elif mat.is_a("IfcMaterialLayerSet"):
                    layers = mat.MaterialLayers or []
                    mname = layers[0].Material.Name if layers else "Unknown"
                elif mat.is_a("IfcMaterialProfileSetUsage"):
                    profiles = mat.ForProfileSet.MaterialProfiles if mat.ForProfileSet else []
                    mname = profiles[0].Material.Name if profiles else "Unknown"
                else:
                    mname = mat.is_a()
            except Exception:
                mname = "Unknown"
            for el in (rel.RelatedObjects or []):
                el_material[el.id()] = mname

    groups: dict[str, dict] = {}
    for el in m.by_type("IfcElement"):
        eid = el.id()
        if group_by == "storey":
            grp = el_storey.get(eid, "Unknown")
        elif group_by == "material":
            grp = el_material.get(eid, "Unknown")
        else:
            grp = el.is_a()

        if grp not in groups:
            groups[grp] = {"count": 0, "volume_m3": 0.0, "area_m2": 0.0}
        groups[grp]["count"] += 1
        v, a = el_qty.get(eid, (0.0, 0.0))
        groups[grp]["volume_m3"] += v
        groups[grp]["area_m2"] += a

    if not groups:
        return "No IfcElement instances found in the loaded model."

    total_els  = sum(g["count"] for g in groups.values())
    total_vol  = sum(g["volume_m3"] for g in groups.values())
    total_area = sum(g["area_m2"] for g in groups.values())

    lines = [
        f"Quantity takeoff  group_by={group_by}",
        f"Source: {_model_source}",
        f"Total elements: {total_els}",
        "",
        f"{'Group':<42} {'Count':>7} {'Volume m³':>12} {'Area m²':>11}",
        "─" * 76,
    ]
    for grp, d in sorted(groups.items(), key=lambda x: -x[1]["volume_m3"]):
        lines.append(
            f"  {grp:<40} {d['count']:>7} {d['volume_m3']:>12.4f} {d['area_m2']:>11.3f}"
        )
    lines.append("─" * 76)
    lines.append(
        f"  {'TOTAL':<40} {total_els:>7} {total_vol:>12.4f} {total_area:>11.3f}"
    )

    if total_vol == 0 and total_area == 0:
        lines.append(
            "\nNote: No IfcElementQuantity data found — this IFC has no embedded quantities.\n"
            "Use speckle_quantities(model_id) to read volumes/areas from the normalizer DB."
        )

    return "\n".join(lines)


@mcp.tool()
def ifc5d_cost_schedule() -> str:
    """
    List all IfcCostSchedule entities and their IfcCostItem hierarchies in the loaded model.
    Shows cost item names, referenced quantities, and cost values.
    Requires a model loaded via ifc_load() or speckle_load().
    """
    m = _require_model()

    schedules = m.by_type("IfcCostSchedule")
    if not schedules:
        return (
            "No IfcCostSchedule found in the loaded model.\n"
            "Cost schedules are embedded in purpose-built 5D IFC files, not in geometry-only exports.\n"
            "Use speckle_quantities(model_id) for quantity takeoff from normalized model data."
        )

    def _qty_str(item) -> str:
        try:
            for qty in (item.CostQuantities or []):
                if qty.is_a("IfcQuantityVolume"):
                    return f"  vol={qty.VolumeValue:.4f}m³"
                if qty.is_a("IfcQuantityArea"):
                    return f"  area={qty.AreaValue:.3f}m²"
                if qty.is_a("IfcQuantityLength"):
                    return f"  len={qty.LengthValue:.3f}m"
                if qty.is_a("IfcQuantityCount"):
                    return f"  count={qty.CountValue}"
                if qty.is_a("IfcQuantityWeight"):
                    return f"  weight={qty.WeightValue:.2f}kg"
        except Exception:
            pass
        return ""

    def _cost_str(item) -> str:
        try:
            for cv in (item.CostValues or []):
                val = getattr(cv, "AppliedValue", None)
                if val is not None:
                    return f"  cost={val}"
        except Exception:
            pass
        return ""

    # Pre-build parent→children map — avoids O(items × relations) quadratic scan
    nests_children: dict[int, list] = {}
    for rel in m.by_type("IfcRelNests"):
        pid = rel.RelatingObject.id()
        for child in (rel.RelatedObjects or []):
            if child.is_a("IfcCostItem"):
                nests_children.setdefault(pid, []).append(child)

    def _item_lines(item, depth: int = 0) -> list[str]:
        indent = "  " * depth
        name = getattr(item, "Name", None) or "(unnamed)"
        result = [f"{indent}#{item.id()} {name}{_cost_str(item)}{_qty_str(item)}"]
        for child in nests_children.get(item.id(), []):
            result.extend(_item_lines(child, depth + 1))
        return result

    lines = [f"{len(schedules)} IfcCostSchedule(s) in {_model_source}:"]
    for sched in schedules:
        name   = getattr(sched, "Name",   None) or "(unnamed)"
        status = getattr(sched, "Status", None) or ""
        lines.append(f"\n[#{sched.id()}] {name}  {status}")

        top_items: list = []
        for rel in m.by_type("IfcRelAssignsToControl"):
            if rel.RelatingControl == sched:
                top_items.extend(
                    o for o in (rel.RelatedObjects or []) if o.is_a("IfcCostItem")
                )
        for rel in m.by_type("IfcRelNests"):
            if rel.RelatingObject == sched:
                top_items.extend(
                    o for o in (rel.RelatedObjects or []) if o.is_a("IfcCostItem")
                )

        if not top_items:
            lines.append("  (no cost items)")
        else:
            for item in top_items:
                lines.extend(_item_lines(item, depth=1))

    return "\n".join(lines)


@mcp.tool()
def ifc5d_boq_export(output_path: str = "") -> str:
    """
    Export Bill of Quantities from the loaded IFC to a spreadsheet file.
    Uses ifc5d's ODS writer when available; falls back to CSV.

    output_path: destination file (.ods or .csv). Defaults to a temp file.
    Returns the path to the generated file.
    Requires a model loaded via ifc_load() or speckle_load().
    """
    m = _require_model()

    # Resolve output path
    if not output_path:
        suffix = ".ods" if (_IFC5D_AVAILABLE and _Ifc5DOdsWriter) else ".csv"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir=tempfile.gettempdir()) as f:
            output_path = f.name

    # Try ifc5d ODS writer first
    if _IFC5D_AVAILABLE and _Ifc5DOdsWriter and output_path.endswith(".ods"):
        try:
            writer = _Ifc5DOdsWriter(m, output_path)
            writer.export()
            return f"BoQ exported to {output_path!r} (ODS via ifc5d)."
        except TypeError:
            try:
                writer = _Ifc5DOdsWriter()
                writer.file = m
                writer.output = output_path
                writer.execute()
                return f"BoQ exported to {output_path!r} (ODS via ifc5d)."
            except Exception as e:
                return (
                    f"ifc5d ODS export failed: {e}\n"
                    f"Re-run with a .csv path for the CSV fallback."
                )
        except Exception as e:
            return (
                f"ifc5d ODS export failed: {e}\n"
                f"Re-run with a .csv path for the CSV fallback."
            )

    # CSV fallback — one row per IfcElement with quantities from IfcElementQuantity
    import csv

    el_qty    = _ifc_qty_by_element(m)
    el_storey = _ifc_storey_by_element(m)

    rows = []
    for el in m.by_type("IfcElement"):
        v, a = el_qty.get(el.id(), (0.0, 0.0))
        rows.append([
            el.is_a(),
            getattr(el, "Name", None) or "",
            el_storey.get(el.id(), ""),
            round(v, 6),
            round(a, 4),
        ])

    if not output_path.endswith(".csv"):
        output_path = output_path + ".csv"

    with open(output_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["IFC Class", "Name", "Storey", "Volume m³", "Area m²"])
        w.writerows(rows)

    note = "" if _IFC5D_AVAILABLE else "  (install ifc5d for ODS format: pip install ifc5d)"
    return f"BoQ exported to {output_path!r} — {len(rows)} elements (CSV).{note}"


@mcp.tool()
def speckle_quantities(model_id: str, group_by: str = "ifc_class") -> str:
    """
    Quantity takeoff for a normalized model read directly from the database.
    Does NOT require loading the IFC into memory — reads volume_m3 / area_m2
    from PostgreSQL bim_geometry, which is faster for large models.

    group_by: 'ifc_class' (default), 'category', or 'storey'
    Use speckle_list_ingested() to find model_id values.
    """
    allowed = {"ifc_class", "category", "storey"}
    if group_by not in allowed:
        return f"group_by must be one of: {', '.join(sorted(allowed))}"

    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/quantities",
        params={"group_by": group_by},
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    d = resp.json()

    total      = d.get("total_elements", 0)
    total_vol  = d.get("total_volume_m3", 0.0)
    total_area = d.get("total_area_m2", 0.0)
    rows       = d.get("rows", [])

    lines = [
        f"Quantity takeoff  model={model_id[:8]}...  group_by={group_by}",
        f"Total elements: {total}  |  Volume: {total_vol:.4f} m³  |  Area: {total_area:.3f} m²",
        "",
        f"{'Group':<42} {'Count':>7} {'Volume m³':>12} {'Area m²':>11} {'Geo%':>5}",
        "─" * 82,
    ]
    for row in rows:
        geo_pct = f"{row['elements_with_geometry'] / max(1, row['element_count']):.0%}"
        lines.append(
            f"  {row['group']:<40} {row['element_count']:>7}"
            f" {row['volume_m3']:>12.4f} {row['area_m2']:>11.3f} {geo_pct:>5}"
        )
    lines.append("─" * 82)
    lines.append(
        f"  {'TOTAL':<40} {total:>7} {total_vol:>12.4f} {total_area:>11.3f}"
    )

    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# PARAMETER / MATERIAL / PROFILE DISCOVERY TOOLS  (issue 8 + 10)
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def speckle_parameter_keys(model_id: str) -> str:
    """
    List all BIM parameter keys for a model, sorted by how many elements carry that key.
    Use these key names with speckle_query_by_parameter() to filter elements.
    → feeds: speckle_query_by_parameter(model_id, key=...)
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/parameters/keys", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    keys = resp.json()
    if not keys:
        return "No parameters stored for this model."
    lines = [f"{len(keys)} parameter key(s) for model {model_id[:8]}...:"]
    for row in keys[:50]:
        lines.append(f"  {row.get('key', '?'):<40}  elements={row.get('element_count', 0)}")
    if len(keys) > 50:
        lines.append(f"  ... and {len(keys) - 50} more")
    return "\n".join(lines)


@mcp.tool()
def speckle_query_by_parameter(
    model_id: str,
    key: str,
    value: str = "",
    op: str = "contains",
    limit: int = 50,
) -> str:
    """
    Filter elements by a BIM parameter key/value with optional numeric operator.
    key: parameter name to match (partial, e.g. 'material', 'grade', 'Volume')
    value: the value to compare against
    op: 'contains' (default), 'eq', 'gt', 'lt', 'gte', 'lte'
        Numeric operators apply to the stored numeric interpretation of value.
    Use speckle_parameter_keys(model_id) to discover available keys.
    → feeds: speckle_element_detail(element_id)
    """
    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/elements/by-parameter",
        params={"key": key, "value": value, "op": op, "limit": limit},
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    if resp.status_code == 422:
        return f"Bad request: {resp.json().get('detail', resp.text)}"
    resp.raise_for_status()
    elements = resp.json()
    if not elements:
        return f"No elements matching {key!r} {op} {value!r}."
    lines = [f"{len(elements)} element(s) where {key!r} {op} {value!r} (limit={limit}):"]
    for e in elements:
        lines.append(
            f"  [{e.get('ifc_class', '?')}] {e.get('name') or '(unnamed)'}"
            f"  storey={e.get('storey') or '?'}"
            f"  {e.get('param_key', '')}={e.get('param_value', '')}"
            f"  element_id={e.get('element_id', '')}"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_find_nearby(
    model_id: str,
    reference: str,
    radius_m: float = 5.0,
    category: str = "",
) -> str:
    """
    Find elements within radius_m meters of a reference element.
    reference: speckle_id or (partial) name of the element to search around.
    category: optional category filter, e.g. 'Columns', 'Walls'.

    Only works for elements ingested with SI geometry (centroid_si) — older
    models may need re-ingestion for this to return results.
    → feeds: speckle_element_detail(element_id)
    """
    params = {"reference": reference, "radius_m": radius_m}
    if category:
        params["category"] = category
    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/elements/nearby",
        params=params,
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    if resp.status_code == 400:
        return f"Bad request: {resp.json().get('detail', resp.text)}"
    resp.raise_for_status()
    data = resp.json()
    elements = data.get("elements", [])
    if not elements:
        return (
            f"No elements found within {radius_m}m of '{reference}'. "
            "This may mean the reference wasn't found, or the model predates "
            "SI geometry support — try re-ingesting."
        )
    lines = [f"{len(elements)} element(s) within {radius_m}m of '{reference}':"]
    for e in elements:
        lines.append(
            f"  [{e.get('ifc_class', '?')}] {e.get('name') or '(unnamed)'}"
            f"  category={e.get('category') or '?'}"
            f"  distance={e.get('distance_m')}m"
            f"  speckle_id={e.get('speckle_id', '')}"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_get_materials(model_id: str) -> str:
    """
    List all distinct material values for a model with element counts.
    → use material names with: speckle_query_by_parameter(model_id, 'material', name)
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/summary", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    data = resp.json()
    by_mat = data.get("by_material", {})
    if not by_mat:
        return "No material parameters found for this model."
    lines = [f"{len(by_mat)} material(s) for model {model_id[:8]}...:"]
    for mat, info in sorted(by_mat.items(), key=lambda x: -x[1].get("count", 0))[:30]:
        lines.append(f"  {mat:<50}  count={info.get('count', 0)}")
    if len(by_mat) > 30:
        lines.append(f"  ... and {len(by_mat) - 30} more")
    return "\n".join(lines)


@mcp.tool()
def speckle_get_profiles(model_id: str) -> str:
    """
    List all distinct structural section/profile values for a model with element counts.
    → use profile names with: speckle_query_by_parameter(model_id, 'profile', name)
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/summary", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    data = resp.json()
    by_prof = data.get("by_profile", {})
    if not by_prof:
        return "No profile/section parameters found for this model."
    lines = [f"{len(by_prof)} profile(s) for model {model_id[:8]}...:"]
    for prof, info in sorted(by_prof.items(), key=lambda x: -x[1].get("count", 0))[:30]:
        lines.append(f"  {prof:<50}  count={info.get('count', 0)}")
    if len(by_prof) > 30:
        lines.append(f"  ... and {len(by_prof) - 30} more")
    return "\n".join(lines)


# ═════════════════════════════════════════════════════════════════════════════
# CLASSIFICATION OVERRIDE TOOLS  (issue 9)
# ═════════════════════════════════════════════════════════════════════════════

@mcp.tool()
def speckle_list_overrides(model_id: str) -> str:
    """
    List all per-element classification overrides stored for a model.
    → after reviewing, apply with: speckle_apply_overrides(model_id)
    """
    resp = requests.get(f"{_NORMALIZER_URL}/models/{model_id}/overrides", timeout=30)
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    overrides = resp.json()
    if not overrides:
        return f"No classification overrides for model {model_id[:8]}..."
    lines = [f"{len(overrides)} override(s):"]
    for o in overrides:
        match = o.get("application_id") or o.get("speckle_id") or "?"
        lines.append(
            f"  {match[:30]:<32}  {o.get('ifc_class', '?')} → {o.get('category', '?')}"
            f"  [{o.get('note') or ''}]"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_set_overrides(model_id: str, overrides_json: str) -> str:
    """
    Upsert per-element classification overrides. Each override must have
    application_id OR speckle_id plus ifc_class and category.

    overrides_json: JSON array, e.g.:
      [{"application_id":"123","ifc_class":"IfcWall","category":"Walls","note":"fix"}]

    Call speckle_apply_overrides(model_id) afterward to write changes into the DB.
    → after setting: speckle_apply_overrides(model_id)
    """
    try:
        items = json.loads(overrides_json)
    except json.JSONDecodeError as exc:
        return f"Invalid JSON: {exc}"
    if not isinstance(items, list):
        return "overrides_json must be a JSON array."

    resp = requests.post(
        f"{_NORMALIZER_URL}/models/{model_id}/overrides",
        json=items,
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    if resp.status_code == 422:
        return f"Validation error: {resp.json().get('detail', resp.text)}"
    resp.raise_for_status()
    result = resp.json()
    return (
        f"Upserted {result.get('upserted', 0)} override(s) for model {model_id[:8]}...\n"
        f"Call speckle_apply_overrides('{model_id}') to write them into bim_elements."
    )


@mcp.tool()
def speckle_apply_overrides(model_id: str) -> str:
    """
    Apply all stored classification overrides to the model's elements in the database.
    Updates ifc_class and category in bim_elements for every matched element.
    → use after: speckle_set_overrides(model_id, ...)
    → verify with: speckle_query_elements(model_id)
    """
    resp = requests.post(
        f"{_NORMALIZER_URL}/models/{model_id}/overrides/apply",
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    result = resp.json()
    return f"Applied overrides: {result.get('updated', 0)} element(s) updated in model {model_id[:8]}..."


@mcp.tool()
def speckle_filter_publish(
    model_id: str,
    target_branch: str,
    message: str = "",
    category: str = "",
    ifc_class: str = "",
    storey: str = "",
    speckle_ids: str = "",
) -> str:
    """
    Filter elements from an ingested model and publish the selection as a new
    version (commit) on the same Speckle server.

    Filter by any combination of:
      category  — e.g. 'Structural Columns', 'Walls'
      ifc_class — e.g. 'IfcColumn', 'IfcWall'
      storey    — partial match, e.g. 'Level 1'
    OR provide speckle_ids as a comma-separated list of Speckle object IDs
    for explicit element selection (takes precedence over the filters above).

    target_branch: branch name to publish to — created automatically if absent.
    message: commit message for the new version.

    Examples:
      speckle_filter_publish("abc-123", "filtered/structural", "Structural only",
                             ifc_class="IfcColumn")
      speckle_filter_publish("abc-123", "filtered/level1", "Level 1 elements",
                             storey="Level 1")
      speckle_filter_publish("abc-123", "filtered/manual", "Custom set",
                             speckle_ids="id1,id2,id3")

    → find category / ifc_class / storey values with: speckle_get_summary(model_id)
    → use model_id from: speckle_list_ingested()
    """
    body: dict = {
        "target_branch": target_branch,
        "message": message,
    }
    if speckle_ids:
        body["speckle_ids"] = [s.strip() for s in speckle_ids.split(",") if s.strip()]
    else:
        if category:
            body["category"] = category
        if ifc_class:
            body["ifc_class"] = ifc_class
        if storey:
            body["storey"] = storey

    resp = requests.post(
        f"{_NORMALIZER_URL}/models/{model_id}/filter-publish",
        json=body,
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    job = resp.json()
    job_id = job.get("job_id")
    if not job_id:
        return f"Unexpected response: {job}"

    # Poll up to 5 minutes
    t0 = time.time()
    for _ in range(60):
        time.sleep(5)
        sr = requests.get(f"{_NORMALIZER_URL}/filter-publish/{job_id}/status", timeout=15)
        sr.raise_for_status()
        s = sr.json()
        if s["status"] == "complete":
            r = s["result"]
            elapsed = int(time.time() - t0)
            return (
                f"Published {r['element_count']} element(s) to branch '{r['branch_name']}' "
                f"(took {elapsed}s).\n"
                f"Commit ID: {r['commit_id']}\n"
                f"Model ID:  {r.get('model_id', '')}\n"
                f"URL: {r['url']}"
            )
        if s["status"] == "failed":
            return f"Filter-publish failed: {s.get('error')}"

    return f"Timed out waiting for filter-publish job {job_id}."


@mcp.tool()
def classification_reload() -> str:
    """
    Reload mapping_revit.json and mapping_ifc_class.json from disk without restarting
    the normalizer service. Call this after editing the classification map config files
    to make the new mappings take effect immediately on the next ingest.
    """
    resp = requests.post(f"{_NORMALIZER_URL}/classification/reload", timeout=15)
    resp.raise_for_status()
    return "Classification maps reloaded from disk. New mappings apply to all future ingests."


# ─────────────────────────────────────────────────────────────────────────────
# QA drill-down / CSV export / cost estimate / trend / IFC pset writer
# ─────────────────────────────────────────────────────────────────────────────

@mcp.tool()
def speckle_qa_elements(model_id: str, issue: str, limit: int = 50) -> str:
    """
    Return the actual elements affected by a specific QA issue.

    Run speckle_qa_check(model_id) first to see issue counts, then drill into
    a specific issue with this tool to get the element list.

    issue: unclassified | no_geometry | no_name | no_storey | no_material | duplicate_ids
    limit: max elements to return (default 50, max 500)

    → fix unclassified elements: speckle_set_overrides(model_id, ...)
    → fix storey/name gaps: edit source model and re-ingest
    """
    VALID = {"unclassified", "no_geometry", "no_name", "no_storey", "no_material", "duplicate_ids"}
    if issue not in VALID:
        return f"Unknown issue '{issue}'. Valid: {', '.join(sorted(VALID))}"

    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/qa/elements",
        params={"issue": issue, "limit": min(limit, 500)},
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id!r} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    elements = resp.json()

    if not elements:
        return f"No elements found for issue '{issue}' — this check passes."

    lines = [f"{len(elements)} element(s) with issue '{issue}' (limit={limit}):"]
    for e in elements:
        name   = e.get("name") or "(unnamed)"
        storey = e.get("storey") or "?"
        lines.append(
            f"  [{e.get('ifc_class') or '?'}] {name}"
            f"  storey={storey}"
            f"  element_id={e.get('element_id', '')}"
            f"  speckle_id={e.get('speckle_id', '')}"
        )
    return "\n".join(lines)


@mcp.tool()
def speckle_export_csv(
    model_id: str,
    output_path: str = "",
    category: str = "",
    ifc_class: str = "",
    storey: str = "",
) -> str:
    """
    Export model elements to a CSV file with geometry quantities and key parameters.

    output_path: destination .csv path. Defaults to a temp file.
    category, ifc_class, storey: optional substring filters.

    Output columns: element_id, speckle_id, ifc_class, category, name, storey,
                    volume_m3, area_m2, material, profile, grade

    Use speckle_list_ingested() to find model_id values.
    """
    params: dict = {}
    if category:  params["category"]  = category
    if ifc_class: params["ifc_class"] = ifc_class
    if storey:    params["storey"]    = storey

    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/export/csv",
        params=params,
        timeout=120,
        stream=True,
    )
    if resp.status_code == 404:
        return f"Model {model_id!r} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()

    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), f"model_{model_id[:8]}.csv")

    row_count = 0
    with open(output_path, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65_536):
            fh.write(chunk)
            row_count += chunk.count(b"\n")

    data_rows = max(0, row_count - 1)  # subtract header
    return f"Exported {data_rows:,} element(s) to {output_path!r}"


@mcp.tool()
def speckle_cost_estimate(model_id: str, rates_json: str, group_by: str = "category") -> str:
    """
    Apply unit rates to model quantities to produce a rough cost estimate (5D).

    rates_json: JSON array of rate rules, e.g.
      '[{"match":"Concrete","unit":"m3","rate":180,"currency":"EUR"},
        {"match":"Steel","unit":"m3","rate":7800,"currency":"EUR"}]'

    Each rule matches the group name (case-insensitive substring).
    unit: "m3" → volume_m3, "m2" → area_m2, "count" → element_count

    group_by: 'category' (default), 'ifc_class', or 'storey'

    Unmatched groups are listed at the bottom so you can extend the rate card.
    Use speckle_list_ingested() to find model_id values.
    """
    try:
        rates = json.loads(rates_json)
    except json.JSONDecodeError as e:
        return f"Invalid JSON in rates_json: {e}"
    if not isinstance(rates, list) or not rates:
        return "rates_json must be a non-empty JSON array."

    resp = requests.get(
        f"{_NORMALIZER_URL}/models/{model_id}/quantities",
        params={"group_by": group_by},
        timeout=30,
    )
    if resp.status_code == 404:
        return f"Model {model_id!r} not found. Use speckle_list_ingested() to verify."
    resp.raise_for_status()
    data = resp.json()
    rows = data.get("rows", [])
    if not rows:
        return "No quantity data available for this model."

    UNIT_FIELDS = {"m3": "volume_m3", "m2": "area_m2", "count": "element_count"}

    def _qty(row, unit):
        return row.get(UNIT_FIELDS.get(unit, "element_count"), 0) or 0

    def _match(group_name):
        for r in rates:
            if r.get("match", "").lower() in group_name.lower():
                return r
        return None

    currency = rates[0].get("currency", "") if rates else ""
    cost_rows, unmatched = [], []

    for row in rows:
        group = row.get("group", "Unknown")
        rule = _match(group)
        if not rule:
            unmatched.append(group)
            continue
        unit = rule.get("unit", "count")
        rate = float(rule.get("rate", 0))
        qty  = _qty(row, unit)
        cost_rows.append((group, qty, unit, rate, qty * rate))

    cost_rows.sort(key=lambda x: -x[4])
    total_cost = sum(c[4] for c in cost_rows)

    W = 36
    lines = [
        f"Cost estimate — model {model_id[:8]}...  group_by={group_by}",
        "",
        f"  {'Group':<{W}} {'Quantity':>12}  {'Rate':>10}  {'Cost':>14}",
        "  " + "─" * (W + 42),
    ]
    for group, qty, unit, rate, cost in cost_rows:
        lines.append(
            f"  {group:<{W}} {qty:>11.2f}{unit}  {rate:>10,.0f}  {cost:>14,.0f} {currency}"
        )
    lines += [
        "  " + "─" * (W + 42),
        f"  {'TOTAL':<{W}} {'':>12}  {'':>10}  {total_cost:>14,.0f} {currency}",
    ]
    if unmatched:
        lines.append(f"\nNo rate matched for: {', '.join(unmatched[:10])}")
        lines.append("Add matching entries to rates_json to include these groups.")

    return "\n".join(lines)


@mcp.tool()
def speckle_trend_analysis(model_id: str, limit: int = 10) -> str:
    """
    Track how model quantities have changed across ingested versions of the same stream.

    model_id: any ingested model from the target stream (provides the stream_id).
    limit: max versions to show, newest first (default 10).

    Returns a timeline of element count and volume per version.
    Useful for construction monitoring: "is concrete volume growing as planned per pour?"

    Use speckle_list_ingested() to find model_id values.
    """
    # Resolve stream_id from model metadata
    meta = requests.get(f"{_NORMALIZER_URL}/models/{model_id}", timeout=15)
    if meta.status_code == 404:
        return f"Model {model_id!r} not found. Use speckle_list_ingested() to verify."
    meta.raise_for_status()
    stream_id = meta.json().get("stream_id", "")
    if not stream_id:
        return "Could not determine stream_id for this model."

    # All ingested versions for this stream (oldest-first from DB)
    trend = requests.get(f"{_NORMALIZER_URL}/models/trend/{stream_id}", timeout=30)
    trend.raise_for_status()
    versions = trend.json()
    if not versions:
        return f"No ingested versions found for stream {stream_id}."

    # Cap to newest `limit` versions
    versions = list(reversed(versions))[:limit]

    # Fetch quantities per version in parallel
    def _fetch_qty(v):
        try:
            r = requests.get(
                f"{_NORMALIZER_URL}/models/{v['model_id']}/quantities",
                params={"group_by": "ifc_class"},
                timeout=20,
            )
            if r.status_code == 200:
                return v["model_id"], r.json()
        except Exception:
            pass
        return v["model_id"], {}

    qty_map: dict = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for mid, data in pool.map(_fetch_qty, versions):
            qty_map[mid] = data

    lines = [f"Version trend — stream {stream_id}  ({len(versions)} version(s) shown)", ""]
    lines.append(
        f"  {'Date':<12} {'Commit':<10} {'Branch':<20} {'Elements':>9} {'Volume m³':>11} {'Δ Elements':>11}"
    )
    lines.append("  " + "─" * 78)

    prev_elements = None
    for v in reversed(versions):  # display oldest → newest
        mid     = v["model_id"]
        date    = str(v.get("ingested_at", ""))[:10]
        commit  = (v.get("commit_id") or mid)[:8]
        branch  = (v.get("branch_name") or "")[:18]
        elements = int(v.get("total_elements") or 0)
        q        = qty_map.get(mid, {})
        volume   = float(q.get("total_volume_m3", 0) or 0)

        delta = ""
        if prev_elements is not None:
            diff  = elements - prev_elements
            delta = f"{diff:+,}"
        prev_elements = elements

        lines.append(
            f"  {date:<12} {commit:<10} {branch:<20} {elements:>9,}"
            f" {volume:>11.1f} {delta:>11}"
        )

    return "\n".join(lines)


@mcp.tool()
def ifc_write_pset(element_ids: str, pset_name: str, properties: str) -> str:
    """
    Write a named property set onto elements in the loaded IFC model.

    element_ids: comma-separated STEP entity IDs (e.g. "42,57,103")
                 OR "all" to target every IfcElement in the model.
    pset_name:   name of the IfcPropertySet to create (or extend if it already exists).
    properties:  JSON object of key→value pairs to write,
                 e.g. '{"Fire Rating":"REI90","Load Bearing":"true"}'

    Requires a model already loaded via ifc_load() or speckle_load().
    Call ifc_save(path) afterwards to persist changes to disk.
    → verify results with: ifc_info(element_id)
    """
    m = _require_model()

    try:
        props = json.loads(properties)
    except json.JSONDecodeError as e:
        return f"Invalid JSON in properties: {e}"
    if not isinstance(props, dict) or not props:
        return "properties must be a non-empty JSON object."

    # Resolve target elements
    if element_ids.strip().lower() == "all":
        targets = list(m.by_type("IfcElement"))
    else:
        try:
            ids = [int(i.strip()) for i in element_ids.split(",") if i.strip()]
        except ValueError:
            return "element_ids must be comma-separated integers or 'all'."
        targets, missing = [], []
        for eid in ids:
            try:
                targets.append(m.by_id(eid))
            except Exception:
                missing.append(eid)
        if missing:
            return f"Entity ID(s) not found: {missing}. Use ifc_select() to find valid IDs."

    if not targets:
        return "No elements matched. Use ifc_select() to find valid element IDs."

    # Build IfcPropertySingleValue list
    import ifcopenshell.guid as guid
    ifc_props = [
        m.createIfcPropertySingleValue(Name=k, NominalValue=m.createIfcLabel(str(v)))
        for k, v in props.items()
    ]

    pset = m.createIfcPropertySet(
        GlobalId=guid.new(),
        OwnerHistory=None,
        Name=pset_name,
        HasProperties=ifc_props,
    )
    m.createIfcRelDefinesByProperties(
        GlobalId=guid.new(),
        OwnerHistory=None,
        RelatedObjects=targets,
        RelatingPropertyDefinition=pset,
    )

    return (
        f"Wrote '{pset_name}' with {len(ifc_props)} properties "
        f"to {len(targets)} element(s).\n"
        f"Properties: {', '.join(props.keys())}\n"
        f"Call ifc_save(path) to persist changes to disk."
    )


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Speckle IFC MCP server")
    ap.add_argument(
        "--transport", default="stdio", choices=["stdio", "streamable-http", "sse"],
        help=(
            "Transport: 'stdio' for local Claude Code (default), "
            "'streamable-http' for HTTP/remote (recommended), "
            "'sse' for legacy HTTP/remote"
        ),
    )
    ap.add_argument("--host", default="0.0.0.0", help="Bind host for HTTP transports (default: 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8003, help="Port for HTTP transports (default: 8003)")
    args, _ = ap.parse_known_args()

    if args.transport in ("streamable-http", "sse"):
        import uvicorn
        from mcp.server.transport_security import TransportSecuritySettings

        print(
            f"WARNING: {args.transport} mode shares a single Python process. "
            "All clients share the same in-memory IFC model — concurrent loads will "
            "clobber each other. Use stdio mode for single-user deployments, or "
            "run one process per client for multi-user remote access.",
            file=sys.stderr,
        )

        # DNS-rebinding protection (mcp SDK) checks the Host/Origin headers against an
        # allow-list. FastMCP defaults this to localhost only, which rejects every
        # request that arrives via a reverse proxy with 421 "Invalid Host header".
        # Add any public hostnames (and LAN host:port combos used for direct testing)
        # via MCP_ALLOWED_HOSTS (comma-separated, e.g. "mcp.example.com,192.168.1.10:8003").
        allowed_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
        allowed_origins = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]
        for host_entry in os.getenv("MCP_ALLOWED_HOSTS", "").split(","):
            host_entry = host_entry.strip()
            if host_entry:
                allowed_hosts.append(host_entry)
                allowed_origins.append(f"https://{host_entry}")
                allowed_origins.append(f"http://{host_entry}")
        mcp.settings.transport_security = TransportSecuritySettings(
            allowed_hosts=allowed_hosts,
            allowed_origins=allowed_origins,
        )

        app = mcp.streamable_http_app() if args.transport == "streamable-http" else mcp.sse_app()

        # ASGI middleware: enforce MCP_API_KEY via either `X-Api-Key: <key>` or
        # `Authorization: Bearer <key>` (the latter is what most MCP clients, e.g. n8n,
        # send by default).
        class _ApiKeyMiddleware:
            def __init__(self, app):
                self._app = app

            async def __call__(self, scope, receive, send):
                if _MCP_API_KEY and scope["type"] == "http":
                    headers = {k.lower(): v for k, v in scope.get("headers", [])}
                    key = headers.get(b"x-api-key", b"").decode()
                    if not key:
                        auth = headers.get(b"authorization", b"").decode()
                        if auth.lower().startswith("bearer "):
                            key = auth[len("Bearer "):]
                    if key != _MCP_API_KEY:
                        from starlette.responses import Response
                        await Response("Unauthorized\n", status_code=401)(scope, receive, send)
                        return
                await self._app(scope, receive, send)

        uvicorn.run(_ApiKeyMiddleware(app), host=args.host, port=args.port)
    else:
        mcp.run()
