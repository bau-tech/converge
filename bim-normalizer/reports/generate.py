"""
Shared BIM report data-gathering.

Single source of truth for converge's standard report types, called from
three surfaces: routers/reports.py (REST API + the dashboard's "Generate
Report" button), chat/agent.py (the in-app AI Assistant), and
converge_mcp.py (the speckle_generate_report MCP tool, via the REST
endpoint). All three get identical report content because they all go
through this one module instead of three separate reimplementations.

Each gather_* function is async (clashes/ids need to await IFC resolution +
a process-pool check; the rest are plain DB reads that don't await anything,
but stay async for a uniform call signature) and returns (title, sections) —
documents/office_export.py's IR: sections is a list of
{"heading": str, "text": str} or
{"heading": str, "table": {"columns": [...], "rows": [[...]]}} dicts.

Raises ValueError on bad/missing input or a not-found resource — callers
translate that into whatever error shape fits their surface (HTTP 400, a
chat text response, an MCP tool's returned string).
"""

from __future__ import annotations

import asyncio
import re
import statistics

import httpx

REPORT_TYPES = {
    "bom", "qa", "clashes", "ids", "documents", "rooms", "schedule", "changes", "bcf", "anomalies",
    "concrete_beams", "steel_beams", "walls", "columns", "floors", "foundations",
    "doors", "windows", "model_summary",
}


def _server_label(server_url: str) -> str:
    return re.sub(r"^https?://", "", (server_url or "").rstrip("/")) or "unknown-server"


async def _speckle_project_name(server_url: str, stream_id: str, token: str | None) -> str | None:
    """Best-effort live lookup of a Speckle project's display name — nothing
    in bim_models caches this (it only stores the opaque stream_id), so a
    lightweight GraphQL call is the only way to get it. Returns None on any
    failure (unreachable server, no token, bad response) so callers fall
    back to stream_id instead of ever blocking report generation on a
    flaky/unreachable Speckle server.

    httpx.AsyncClient rather than `requests` — every gather_* function is
    async, and this used to be the one call in the whole title-generation
    path still made with a blocking `requests.post`, stalling the entire
    event loop (up to the 8s timeout) on every single report generation."""
    if not token:
        return None
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(
                f"{server_url.rstrip('/')}/graphql",
                json={"query": "query($id:String!){stream(id:$id){name}}", "variables": {"id": stream_id}},
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
        if resp.status_code != 200:
            return None
        name = (((resp.json().get("data") or {}).get("stream") or {}).get("name") or "").strip()
        return name or None
    except Exception:
        return None


async def _speckle_project_and_version(
    server_url: str, stream_id: str, commit_id: str, token: str | None,
) -> tuple[str | None, str | None]:
    """Like _speckle_project_name, but also fetches the commit's creation
    date in the same GraphQL round-trip — Speckle versions aren't
    sequentially numbered, so a "vN" label isn't available; the date it was
    actually created is a more meaningful "Version" than the commit hash.
    Returns (None, None) on any failure so callers fall back gracefully."""
    if not token:
        return None, None
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(
                f"{server_url.rstrip('/')}/graphql",
                json={
                    "query": "query($id:String!,$cid:String!){stream(id:$id){name commit(id:$cid){createdAt}}}",
                    "variables": {"id": stream_id, "cid": commit_id},
                },
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
        if resp.status_code != 200:
            return None, None
        stream = ((resp.json().get("data") or {}).get("stream")) or {}
        name = (stream.get("name") or "").strip() or None
        created_at = ((stream.get("commit") or {}).get("createdAt") or "")
        return name, (created_at[:10] or None)
    except Exception:
        return None, None


async def _project_label(conn, stream_id: str, server_url: str | None = None) -> str:
    """"Server-Project" — the project-scoped half of _model_label, used
    where a report has no single model/version (e.g. a document register
    spanning every model in the project)."""
    from config import settings

    if not server_url:
        with conn.cursor() as cur:
            cur.execute("SELECT server_url FROM bim_models WHERE stream_id = %s LIMIT 1", (stream_id,))
            row = cur.fetchone()
        server_url = row[0] if row else None
    url = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    token = settings.SPECKLE_SERVER_TOKENS.get(url) or settings.SPECKLE_TOKEN
    project_name = await _speckle_project_name(url, stream_id, token) or stream_id
    return f"{_server_label(url)}-{project_name}"


async def _model_label(conn, model_id: str) -> str:
    """"Server-Project-Model-Version" — used as every model-scoped report's
    title instead of a raw model_id, since a UUID prefix means nothing to
    whoever reads the report. "Model" is branch_name (a Speckle model IS a
    branch). "Version" is the version's creation date (YYYY-MM-DD) — Speckle
    versions aren't sequentially numbered, so a date is the most meaningful
    stable identifier available; falls back to this model's own ingested_at
    date (always present locally) if the live commit lookup fails, and only
    as a last resort to the commit_id's short hash."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT stream_id, commit_id, branch_name, server_url, ingested_at FROM bim_models WHERE model_id = %s",
            (model_id,),
        )
        row = cur.fetchone()
    if not row:
        return model_id[:8]
    stream_id, commit_id, branch_name, server_url, ingested_at = row

    from config import settings
    url = (server_url or settings.SPECKLE_SERVER_URL).rstrip("/")
    token = settings.SPECKLE_SERVER_TOKENS.get(url) or settings.SPECKLE_TOKEN
    project_name, version_date = await _speckle_project_and_version(url, stream_id, commit_id or "", token)

    project_label = f"{_server_label(url)}-{project_name or stream_id}"
    model_name = branch_name or "model"
    version = version_date or (str(ingested_at)[:10] if ingested_at else "") or (commit_id or "")[:8] or "?"
    return f"{project_label}-{model_name}-{version}"


async def gather_bom(conn, model_id: str) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='bom'.")
    from db.query import get_quantity_takeoff
    d = get_quantity_takeoff(conn, model_id, group_by="material")
    rows = [[r["group"], r["element_count"], round(r["volume_m3"], 3), round(r["area_m2"], 3)] for r in d.get("rows", [])]
    sections = [
        {"heading": "Summary", "text": (
            f"Total elements: {d.get('total_elements', 0)}\n"
            f"Total volume: {d.get('total_volume_m3', 0):.2f} m³\n"
            f"Total area: {d.get('total_area_m2', 0):.2f} m²"
        )},
        {"heading": "By Material", "table": {"columns": ["Material", "Element Count", "Volume (m³)", "Area (m²)"], "rows": rows}},
    ]
    return f"Bill of Materials — {await _model_label(conn, model_id)}", sections


async def gather_qa(conn, model_id: str) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='qa'.")
    from db.query import get_model_qa
    d = get_model_qa(conn, model_id)
    total = d.get("total_elements", 0)
    score = d.get("score", 0.0)
    labels = {
        "unclassified":  "Unclassified elements",
        "no_geometry":   "No geometry (quantities unavailable)",
        "no_name":       "Missing element names",
        "no_storey":     "No storey assignment",
        "no_material":   "No material parameter",
        "duplicate_ids": "Duplicate application IDs",
    }
    issues = d.get("issues", {})
    rows = []
    for key, label in labels.items():
        issue = issues.get(key, {})
        count = issue.get("count", 0)
        pct = f"{count / total:.0%}" if total else "-"
        samples = ", ".join(str(s) for s in issue.get("samples", [])[:3])
        rows.append([label, count, pct, samples])
    sections = [
        {"heading": "Summary", "text": f"Total elements: {total}\nQuality score: {score:.1%}"},
        {"heading": "Issues", "table": {"columns": ["Issue", "Count", "% of Total", "Sample Speckle IDs"], "rows": rows}},
    ]
    return f"Data Quality Report — {await _model_label(conn, model_id)}", sections


async def gather_clashes(
    conn, model_id: str, rules: list[dict], compared_model_id: str = "",
    token: str | None = None, server_url: str | None = None, coord_unit: str = "mm",
) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='clashes'.")
    if not rules:
        raise ValueError("rules is required for report_type='clashes' — a non-empty list of {selector_a, selector_b?, mode?, ...} dicts.")
    from clash_check import run_clash_checks, run_cross_model_clash_checks
    from process_pool import run_cpu_bound
    from routers.ifc_export import build_revit_guid_map, resolve_model_ifc_bytes

    if compared_model_id:
        (ifc_bytes_a, ifc_source_a), (ifc_bytes_b, ifc_source_b) = await asyncio.gather(
            resolve_model_ifc_bytes(model_id, token, server_url, coord_unit),
            resolve_model_ifc_bytes(compared_model_id, token, server_url, coord_unit),
        )
        guid_map_a = await build_revit_guid_map(model_id) if ifc_source_a == "original_ifc" else {}
        guid_map_b = await build_revit_guid_map(compared_model_id) if ifc_source_b == "original_ifc" else {}
        rule_results = await run_cpu_bound(
            run_cross_model_clash_checks, ifc_bytes_a, ifc_bytes_b, rules,
            ifc_source_a == "synthetic_export", ifc_source_b == "synthetic_export",
            guid_map_a, guid_map_b,
        )
    else:
        ifc_bytes, ifc_source = await resolve_model_ifc_bytes(model_id, token, server_url, coord_unit)
        guid_map = await build_revit_guid_map(model_id) if ifc_source == "original_ifc" else {}
        rule_results = await run_cpu_bound(run_clash_checks, ifc_bytes, rules, ifc_source == "synthetic_export", guid_map)

    total = sum(r.get("count", 0) for r in rule_results)
    rows = [
        [r.get("name") or f"{r.get('selector_a')} vs {r.get('selector_b') or r.get('selector_a')}",
         r.get("selector_a", ""), r.get("selector_b", "") or "(self)", r.get("count", 0)]
        for r in rule_results
    ]
    sections = [
        {"heading": "Summary", "text": f"Total clashes: {total} across {len(rule_results)} rule(s)."},
        {"heading": "By Rule", "table": {"columns": ["Rule", "Selector A", "Selector B", "Clash Count"], "rows": rows}},
    ]
    return f"Clash Detection Report — {await _model_label(conn, model_id)}", sections


async def gather_ids(
    conn, model_id: str, spec_id: str,
    token: str | None = None, server_url: str | None = None, coord_unit: str = "mm",
) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='ids'.")
    if not spec_id:
        raise ValueError("spec_id is required for report_type='ids'.")
    with conn.cursor() as cur:
        cur.execute("SELECT content FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s", (model_id, spec_id))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"IDS spec {spec_id} not found for model {model_id}.")
    ids_content = row[0]

    from ids_check import run_ids_check
    from process_pool import run_cpu_bound
    from routers.ifc_export import build_revit_guid_map, resolve_model_ifc_bytes

    ifc_bytes, ifc_source = await resolve_model_ifc_bytes(model_id, token, server_url, coord_unit)
    revit_guid_map = await build_revit_guid_map(model_id) if ifc_source == "original_ifc" else {}
    report = await run_cpu_bound(run_ids_check, ifc_bytes, ids_content, ifc_source == "synthetic_export", revit_guid_map)

    specs = report.get("specifications", [])
    overall = "PASS" if report.get("status") else "FAIL"
    rows = [
        [s.get("name", "Unnamed"), "PASS" if s.get("status") else "FAIL", f"{s.get('total_checks_pass', 0)}/{s.get('total_checks', 0)}"]
        for s in specs
    ]
    fail_lines = [
        f"{s.get('name', '?')}: {req.get('description') or req.get('label', '?')} "
        f"({req.get('total_pass', 0)} passed / {req.get('total_fail', 0)} failed)"
        for s in specs for req in s.get("requirements", []) if not req.get("status")
    ]
    sections = [
        {"heading": "Summary", "text": (
            f"Overall: {overall}\n"
            f"{report.get('total_specifications_pass', 0)}/{report.get('total_specifications', 0)} specifications passed\n"
            f"Checked against: {ifc_source}"
        )},
        {"heading": "Specifications", "table": {"columns": ["Specification", "Result", "Checks Passed"], "rows": rows}},
    ]
    if fail_lines:
        sections.append({"heading": "Failed Requirements", "text": "\n".join(fail_lines)})
    return f"IDS Compliance Report — {await _model_label(conn, model_id)}", sections


async def gather_documents(conn, stream_id: str, viewer_org_id: str | None = None) -> tuple[str, list[dict]]:
    if not stream_id:
        raise ValueError("stream_id is required for report_type='documents'.")
    from db.documents import list_documents
    docs = list_documents(conn, stream_id, viewer_org_id=viewer_org_id)
    rows = []
    for d in docs:
        gates = "".join([
            "R" if d.get("reviewed") else "-",
            "A" if d.get("approved") else "-",
            "V" if d.get("verified") else "-",
        ])
        rows.append([d.get("filename", ""), d.get("status", ""), d.get("revision", ""), gates, d.get("doc_id", "")])
    sections = [
        {"heading": "Summary", "text": f"{len(docs)} document(s). Gates: R=reviewed A=approved V=verified."},
        {"heading": "Documents", "table": {"columns": ["Filename", "Status", "Revision", "Gates", "Doc ID"], "rows": rows}},
    ]
    return f"Document Register — {await _project_label(conn, stream_id)}", sections


async def gather_rooms(conn, model_id: str) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='rooms'.")
    from db.query import get_elements_flat
    elements = get_elements_flat(conn, model_id, limit=5000, ifc_class="IfcSpace").get("elements", [])
    if not elements:
        elements = get_elements_flat(conn, model_id, limit=5000, category="Room").get("elements", [])
    title = f"Room / Space Schedule — {await _model_label(conn, model_id)}"
    if not elements:
        return title, [{"heading": "No rooms/spaces found", "text": "No IfcSpace elements or Room-category elements were found in this model."}]

    total_area = 0.0
    rows = []
    for e in sorted(elements, key=lambda e: (e.get("storey") or "", e.get("name") or "")):
        area = e.get("area_m2") or 0
        total_area += area
        rows.append([e.get("name") or "(unnamed)", e.get("storey") or "-", round(area, 2), e.get("speckle_id", "")])
    sections = [
        {"heading": "Summary", "text": f"{len(elements)} room(s)/space(s), total area {total_area:.2f} m²."},
        {"heading": "Rooms", "table": {"columns": ["Name", "Storey", "Area (m²)", "Speckle ID"], "rows": rows}},
    ]
    return title, sections


def _elements_by_filter(conn, model_id: str, ifc_class: str | None, category_substr: str | None, prefer: str) -> list[dict]:
    """Try ifc_class first then category (or vice versa per `prefer`), same
    two-tier fallback gather_rooms already uses — IFC-native models
    reliably set ifc_class; Revit-sourced ones are often more consistently
    categorized. prefer="category" for element types IFC lumps together
    under one class (e.g. IfcSlab covers both floors and roofs — category
    is the only signal that tells them apart)."""
    from db.query import get_elements_flat

    def _by_ifc_class():
        return get_elements_flat(conn, model_id, limit=5000, ifc_class=ifc_class).get("elements", []) if ifc_class else []

    def _by_category():
        return get_elements_flat(conn, model_id, limit=5000, category=category_substr).get("elements", []) if category_substr else []

    first, second = (_by_ifc_class, _by_category) if prefer == "ifc_class" else (_by_category, _by_ifc_class)
    elements = first()
    if not elements:
        elements = second()
    return elements


async def gather_element_schedule(
    conn, model_id: str, title: str, ifc_class: str | None = None,
    category_substr: str | None = None, material_category: str | None = None,
    prefer: str = "ifc_class",
) -> tuple[str, list[dict]]:
    """Shared implementation behind the 6 named element-schedule report
    types below (concrete/steel beams, walls, columns, floors,
    foundations) — one filtered + optionally material-scoped element list,
    formatted the same way regardless of which type it's for."""
    if not model_id:
        raise ValueError(f"model_id is required for report_type={title!r}.")
    elements = _elements_by_filter(conn, model_id, ifc_class, category_substr, prefer)
    if material_category:
        elements = [e for e in elements if (e.get("material_category") or "").lower() == material_category]

    full_title = f"{title} — {await _model_label(conn, model_id)}"
    if not elements:
        return full_title, [{"heading": "No elements found", "text": "No elements matched this report's filters in this model."}]

    total_volume = total_area = 0.0
    rows = []
    for e in sorted(elements, key=lambda e: (e.get("storey") or "", e.get("name") or "")):
        vol = e.get("volume_m3") or 0
        area = e.get("area_m2") or 0
        total_volume += vol
        total_area += area
        rows.append([
            e.get("name") or "(unnamed)", e.get("storey") or "-", e.get("material") or "-",
            round(vol, 3), round(area, 3), e.get("speckle_id", ""),
        ])
    sections = [
        {"heading": "Summary", "text": f"{len(elements)} element(s)  ·  total volume {total_volume:.2f} m³  ·  total area {total_area:.2f} m²."},
        {"heading": "Elements", "table": {
            "columns": ["Name", "Storey", "Material", "Volume (m³)", "Area (m²)", "Speckle ID"],
            "rows": rows,
        }},
    ]
    return full_title, sections


async def gather_concrete_beams(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Concrete Beam Schedule", ifc_class="IfcBeam", material_category="concrete")


async def gather_steel_beams(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Steel Beam Schedule", ifc_class="IfcBeam", material_category="steel")


async def gather_walls(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Wall Schedule", ifc_class="IfcWall", category_substr="Wall")


async def gather_columns(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Column Schedule", ifc_class="IfcColumn", category_substr="Column")


async def gather_floors(conn, model_id: str) -> tuple[str, list[dict]]:
    # prefer="category": IfcSlab covers roofs too, so category (Revit's own
    # "Floors" vs "Roofs" split) is the more reliable signal here — see
    # _elements_by_filter's docstring.
    return await gather_element_schedule(conn, model_id, "Floor Schedule", ifc_class="IfcSlab", category_substr="Floor", prefer="category")


async def gather_foundations(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Foundation Schedule", ifc_class="IfcFooting", category_substr="Foundation")


async def gather_doors(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Door Schedule", ifc_class="IfcDoor", category_substr="Door")


async def gather_windows(conn, model_id: str) -> tuple[str, list[dict]]:
    return await gather_element_schedule(conn, model_id, "Window Schedule", ifc_class="IfcWindow", category_substr="Window")


async def gather_model_summary(conn, model_id: str, viewer_snapshot: bytes | None = None) -> tuple[str, list[dict]]:
    """A one-page project fact sheet — source/author/quantities/category
    breakdowns already computed by get_model_summary() for the dashboard's
    own charts, reused here as-is, plus an optional 3D view captured
    client-side (the backend has no 3D rendering capability of its own —
    see the "clash reports can't get thumbnails" limitation discussed
    earlier; this report can only show a view if the caller supplies one)."""
    if not model_id:
        raise ValueError("model_id is required for report_type='model_summary'.")
    from db.query import get_model_summary
    from reports.charts import bar_chart_png, pie_chart_png
    d = get_model_summary(conn, model_id)

    def _dist_table(dist: dict) -> list[list]:
        rows = sorted((dist or {}).items(), key=lambda kv: -(kv[1].get("volume_m3") or 0))
        return [[k, v.get("count", 0), round(v.get("volume_m3") or 0, 2), round(v.get("area_m2") or 0, 2)] for k, v in rows]

    sections = []
    if viewer_snapshot:
        sections.append({"heading": "3D View", "images": [{"data": viewer_snapshot}]})
    sections.append({"heading": "Model Information", "text": (
        f"Source: {d.get('source') or '?'}\n"
        f"Author: {d.get('author') or '?'}\n"
        f"Branch: {d.get('branch_name') or '?'}\n"
        f"Message: {d.get('message') or '-'}\n"
        f"Ingested: {(d.get('ingested_at') or '')[:10] or '?'}"
    )})
    sections.append({"heading": "Quantities", "text": (
        f"Total elements: {d.get('total_count', 0)}\n"
        f"Total volume: {d.get('total_volume_m3', 0):.2f} m³\n"
        f"Total area: {d.get('total_area_m2', 0):.2f} m²\n"
        f"Geometry coverage: {d.get('geo_coverage', 0):.0%}\n"
        f"Concrete volume: {d.get('total_concrete_volume_m3', 0):.2f} m³\n"
        f"Steel weight: {d.get('total_steel_weight_kg', 0):.1f} kg"
    )})

    # Charts as their own images-only section (not bundled into the table
    # sections below): build_xlsx_report picks table OR images per section,
    # not both, so a combined section would silently drop the chart on the
    # xlsx sheet even though docx/pdf render both fine.
    chart_images = []
    if d.get("by_category"):
        cat_pairs = sorted(d["by_category"].items(), key=lambda kv: -(kv[1].get("count") or 0))
        png = pie_chart_png([k for k, _ in cat_pairs], [v.get("count", 0) for _, v in cat_pairs])
        if png:
            chart_images.append({"caption": "Element count by category", "data": png})
    if d.get("by_ifc_class"):
        cls_pairs = sorted(d["by_ifc_class"].items(), key=lambda kv: -(kv[1].get("count") or 0))
        png = bar_chart_png([k for k, _ in cls_pairs], [v.get("count", 0) for _, v in cls_pairs])
        if png:
            chart_images.append({"caption": "Element count by IFC class", "data": png})
    if chart_images:
        sections.append({"heading": "Charts", "images": chart_images})

    if d.get("by_category"):
        sections.append({"heading": "By Category", "table": {"columns": ["Category", "Count", "Volume (m³)", "Area (m²)"], "rows": _dist_table(d["by_category"])}})
    if d.get("by_ifc_class"):
        sections.append({"heading": "By IFC Class", "table": {"columns": ["IFC Class", "Count", "Volume (m³)", "Area (m²)"], "rows": _dist_table(d["by_ifc_class"])}})
    if d.get("by_storey"):
        sections.append({"heading": "By Storey", "table": {"columns": ["Storey", "Count", "Volume (m³)", "Area (m²)"], "rows": _dist_table(d["by_storey"])}})

    return f"Model Summary — {await _model_label(conn, model_id)}", sections


async def gather_schedule(conn, model_id: str) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='schedule'.")
    from db.schedule import get_schedule
    data = get_schedule(conn, model_id)
    tasks = data.get("tasks", [])
    title = f"4D Schedule Report — {await _model_label(conn, model_id)}"
    if not tasks:
        return title, [{"heading": "No schedule imported", "text": "Import a schedule via the frontend's Schedule widget (IfcWorkSchedule or Primavera P6 XML) first."}]
    rows = [
        [t.get("name", "Unnamed Task"), t.get("status") or "unknown",
         "Yes" if t.get("is_critical") else "", "Yes" if t.get("is_milestone") else "",
         t.get("planned_start") or "", t.get("planned_finish") or "", t.get("element_count", 0)]
        for t in tasks
    ]
    sections = [
        {"heading": "Summary", "text": f"{data.get('task_count', len(tasks))} task(s). {data.get('project_start', '?')} → {data.get('project_end', '?')}"},
        {"heading": "Tasks", "table": {"columns": ["Task", "Status", "Critical", "Milestone", "Start", "Finish", "Elements"], "rows": rows}},
    ]
    return title, sections


async def gather_changes(conn, model_id: str, compared_model_id: str) -> tuple[str, list[dict]]:
    if not model_id or not compared_model_id:
        raise ValueError("Both model_id (current/newer) and compared_model_id (baseline/older) are required for report_type='changes'.")
    from db.query import get_model_diff
    d = get_model_diff(conn, compared_model_id, model_id)
    cat_changes = [c for c in d.get("category_changes", []) if c["delta"] != 0]
    rows = [[c["category"], c["other_count"], c["current_count"], c["delta"]] for c in sorted(cat_changes, key=lambda x: -abs(x["delta"]))]
    changed_rows = [[c.get("category", ""), c.get("name", ""), c.get("speckle_id_b", "")] for c in d.get("changed", [])[:50]]
    added_count, removed_count, changed_count = len(d.get("added", [])), len(d.get("removed", [])), len(d.get("changed", []))
    sections = [
        {"heading": "Summary", "text": (
            f"Baseline: {d.get('other_total', '?')} elements\n"
            f"Current: {d.get('current_total', '?')} elements\n"
            f"Net delta: {d.get('current_total', 0) - d.get('other_total', 0):+d}\n"
            f"Added: {added_count}   Removed: {removed_count}   Changed: {changed_count}"
        )},
        {"heading": "Category Deltas", "table": {"columns": ["Category", "Baseline Count", "Current Count", "Delta"], "rows": rows}},
    ]
    if changed_rows:
        sections.append({"heading": "Changed Elements (sample)", "table": {"columns": ["Category", "Name", "Speckle ID"], "rows": changed_rows}})
    baseline_label, current_label = await asyncio.gather(_model_label(conn, compared_model_id), _model_label(conn, model_id))
    return f"Model Change Report — {baseline_label} → {current_label}", sections


_BCF_MAX_THUMBNAILS = 50  # bounds worst-case sequential round-trips for a project with a huge open-topic backlog


async def gather_bcf(conn, model_id: str, bcf_server_url: str, bcf_api_key: str) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='bcf'.")
    if not bcf_server_url:
        raise ValueError("BCF_SERVER_URL is not configured — BCF reports are unavailable.")
    base = f"{bcf_server_url.rstrip('/')}/bcf/2.1/projects/{model_id}"
    headers = {"Authorization": f"Bearer {bcf_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{base}/topics", headers=headers)
            if resp.status_code == 404:
                raise ValueError(f"Model {model_id} not found on bcf-server.")
            if resp.status_code != 200:
                raise ValueError(f"Could not list topics: {resp.text}")
            topics = resp.json()

            # One thumbnail per topic (its first viewpoint that has a
            # snapshot), shown inline in the Topics table's own "Image"
            # column rather than as a separate full-page gallery afterward
            # — the table stays the single place that shows "what's open
            # and what does it look like" together. A topic's viewpoint
            # listing only has snapshot metadata (snapshot_format), not the
            # image bytes — the actual PNG/JPEG needs one more GET per
            # viewpoint at its own /snapshot route.
            rows = []
            for t in topics:
                guid = t.get("guid")
                thumb = None
                if guid and len(rows) < _BCF_MAX_THUMBNAILS:
                    try:
                        vp_resp = await client.get(f"{base}/topics/{guid}/viewpoints", headers=headers)
                        if vp_resp.status_code == 200:
                            for vp in vp_resp.json():
                                if not vp.get("snapshot_format"):
                                    continue
                                snap_resp = await client.get(
                                    f"{base}/topics/{guid}/viewpoints/{vp.get('guid')}/snapshot", headers=headers,
                                )
                                if snap_resp.status_code == 200 and snap_resp.content:
                                    thumb = {"type": "image", "data": snap_resp.content}
                                break
                    except httpx.RequestError:
                        pass
                rows.append([
                    t.get("title", ""), thumb, t.get("topic_status") or "?",
                    t.get("priority") or "-", t.get("assigned_to") or "-", t.get("guid", ""),
                ])
    except httpx.RequestError as exc:
        raise ValueError(f"Could not reach bcf-server: {exc}")

    sections = [
        {"heading": "Summary", "text": f"{len(topics)} coordination topic(s)."},
        {"heading": "Topics", "table": {
            "columns": ["Title", "Image", "Status", "Priority", "Assigned To", "GUID"], "rows": rows,
        }},
    ]
    return f"BCF Coordination Report — {await _model_label(conn, model_id)}", sections


async def gather_anomalies(conn, model_id: str, group_by: str = "category", metric: str = "volume_m3", threshold: float = 3.5) -> tuple[str, list[dict]]:
    if not model_id:
        raise ValueError("model_id is required for report_type='anomalies'.")
    if metric not in ("volume_m3", "area_m2"):
        raise ValueError("metric must be 'volume_m3' or 'area_m2'.")
    if group_by not in ("category", "ifc_class", "storey"):
        raise ValueError("group_by must be 'category', 'ifc_class', or 'storey'.")
    from db.query import get_elements_for_grouping
    elements = get_elements_for_grouping(conn, model_id, group_by, metric)

    groups: dict = {}
    for e in elements:
        val = e.get(metric)
        if val is None:
            continue
        groups.setdefault(e.get(group_by) or "Unknown", []).append(e)

    anomalies = []
    for key, els in groups.items():
        if len(els) < 5:
            continue
        vals = [float(e[metric]) for e in els]
        median = statistics.median(vals)
        mad = statistics.median(abs(v - median) for v in vals)
        if mad == 0:
            continue
        for e, v in zip(els, vals):
            mz = 0.6745 * (v - median) / mad
            if abs(mz) >= threshold:
                anomalies.append((e, key, v, median, mz))
    anomalies.sort(key=lambda a: -abs(a[4]))

    rows = [
        [key, "HIGH" if mz > 0 else "LOW", e.get("name") or "(unnamed)", round(v, 3), round(median, 3), round(mz, 1), e.get("element_id", "")]
        for e, key, v, median, mz in anomalies[:100]
    ]
    sections = [
        {"heading": "Summary", "text": (
            f"{len(anomalies)} {metric} outlier(s) found across {len(groups)} {group_by} group(s), "
            f"{len(elements)} elements total (threshold={threshold})."
        )},
        {"heading": "Outliers", "table": {"columns": [group_by.capitalize(), "Direction", "Name", metric, "Group Median", "Z-Score", "Element ID"], "rows": rows}},
    ]
    return f"Anomaly Report — {await _model_label(conn, model_id)}", sections
