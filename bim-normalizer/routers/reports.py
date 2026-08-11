"""
Report generation REST API — backs the dashboard's "Generate Report" button.

Shares reports/generate.py's 19 gatherers with chat/agent.py's report tool
and converge_mcp.py's speckle_generate_report MCP tool (which calls this
endpoint rather than reimplementing the gatherers) — one implementation,
three surfaces.
"""

import base64
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from dashboard_auth.dependencies import ANY_PROJECT_ROLE, CurrentUser, require_login, require_project_role
from job_registry import _content_disposition

router = APIRouter(tags=["reports"])

_MIME = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pdf": "application/pdf",
}

_REPORT_DESCRIPTIONS = {
    "bom":            {"label": "Bill of Materials",       "needs": ["model_id"]},
    "qa":             {"label": "Data Quality Report",      "needs": ["model_id"]},
    "clashes":        {"label": "Clash Detection Report",   "needs": ["model_id", "rules"], "optional": ["compared_model_id"]},
    "ids":            {"label": "IDS Compliance Report",    "needs": ["model_id", "spec_id"]},
    "documents":      {"label": "Document Register",        "needs": ["stream_id"]},
    "rooms":          {"label": "Room / Space Schedule",    "needs": ["model_id"]},
    "schedule":       {"label": "4D Schedule Report",       "needs": ["model_id"]},
    "changes":        {"label": "Model Change Report",      "needs": ["model_id", "compared_model_id"]},
    "bcf":            {"label": "BCF Coordination Report",  "needs": ["model_id"]},
    "anomalies":      {"label": "Anomaly Report",           "needs": ["model_id"]},
    "concrete_beams": {"label": "Concrete Beam Schedule",   "needs": ["model_id"]},
    "steel_beams":    {"label": "Steel Beam Schedule",      "needs": ["model_id"]},
    "walls":          {"label": "Wall Schedule",            "needs": ["model_id"]},
    "columns":        {"label": "Column Schedule",          "needs": ["model_id"]},
    "floors":         {"label": "Floor Schedule",           "needs": ["model_id"]},
    "foundations":    {"label": "Foundation Schedule",      "needs": ["model_id"]},
    "doors":          {"label": "Door Schedule",             "needs": ["model_id"]},
    "windows":        {"label": "Window Schedule",           "needs": ["model_id"]},
    "model_summary":  {"label": "Model Summary",             "needs": ["model_id"], "optional": ["viewer_snapshot"]},
}


class GenerateReportRequest(BaseModel):
    report_type: str
    model_id: str | None = None
    stream_id: str | None = None
    output_format: str = "pdf"
    compared_model_id: str | None = None
    rules: list[dict] | None = None
    spec_id: str | None = None
    upload: bool = False
    folder_path: str | None = None
    doc_type: str = "document"
    filename: str | None = None
    token: str | None = None       # overrides env SPECKLE_TOKEN — clashes/ids only
    server_url: str | None = None  # overrides the model's stored ingest server — clashes/ids only
    viewer_snapshot: str | None = None  # base64 PNG captured client-side from the live 3D viewer — model_summary only


@router.get("/reports/types")
def list_report_types():
    """Report types + which id(s) each needs, so the frontend's "Generate
    Report" picker can show/hide the right inputs without hardcoding this
    list a second time."""
    from reports.generate import REPORT_TYPES
    return [{"report_type": rt, **_REPORT_DESCRIPTIONS[rt]} for rt in sorted(REPORT_TYPES)]


@router.post("/reports/generate")
async def generate_report(body: GenerateReportRequest, user: CurrentUser = Depends(require_login)):
    """
    Generate one of converge's standard BIM reports as a real .docx/.xlsx/.pdf
    file. Returns the file directly (upload=False, default) or uploads it
    into stream_id's CDE WIP folder (upload=True — requires an author/
    reviewer/approver role on that project, same gate as a manual document
    upload) and returns the created document's metadata instead.
    """
    from reports.generate import (
        REPORT_TYPES, gather_anomalies, gather_bcf, gather_bom, gather_changes,
        gather_clashes, gather_columns, gather_concrete_beams, gather_documents,
        gather_doors, gather_floors, gather_foundations, gather_ids, gather_model_summary,
        gather_qa, gather_rooms, gather_schedule, gather_steel_beams, gather_walls, gather_windows,
    )

    if body.report_type not in REPORT_TYPES:
        raise HTTPException(status_code=400, detail=f"report_type must be one of: {', '.join(sorted(REPORT_TYPES))}")
    if body.output_format not in ("docx", "xlsx", "pdf"):
        raise HTTPException(status_code=400, detail="output_format must be 'docx', 'xlsx', or 'pdf'.")

    from db.connection import get_conn, release_conn
    conn = get_conn()
    try:
        if body.upload:
            if not body.stream_id:
                raise HTTPException(status_code=400, detail="stream_id is required when upload=True.")
            require_project_role(conn, body.stream_id, user, ANY_PROJECT_ROLE)
        try:
            if body.report_type == "bom":
                title, sections = await gather_bom(conn, body.model_id)
            elif body.report_type == "qa":
                title, sections = await gather_qa(conn, body.model_id)
            elif body.report_type == "clashes":
                title, sections = await gather_clashes(
                    conn, body.model_id, body.rules or [], body.compared_model_id or "", body.token, body.server_url,
                )
            elif body.report_type == "ids":
                title, sections = await gather_ids(conn, body.model_id, body.spec_id, body.token, body.server_url)
            elif body.report_type == "documents":
                title, sections = await gather_documents(conn, body.stream_id, viewer_org_id=user.org_id)
            elif body.report_type == "rooms":
                title, sections = await gather_rooms(conn, body.model_id)
            elif body.report_type == "schedule":
                title, sections = await gather_schedule(conn, body.model_id)
            elif body.report_type == "changes":
                title, sections = await gather_changes(conn, body.model_id, body.compared_model_id or "")
            elif body.report_type == "bcf":
                from config.settings import BCF_API_KEY, BCF_SERVER_URL
                title, sections = await gather_bcf(conn, body.model_id, BCF_SERVER_URL, BCF_API_KEY)
            elif body.report_type == "anomalies":
                title, sections = await gather_anomalies(conn, body.model_id)
            elif body.report_type == "concrete_beams":
                title, sections = await gather_concrete_beams(conn, body.model_id)
            elif body.report_type == "steel_beams":
                title, sections = await gather_steel_beams(conn, body.model_id)
            elif body.report_type == "walls":
                title, sections = await gather_walls(conn, body.model_id)
            elif body.report_type == "columns":
                title, sections = await gather_columns(conn, body.model_id)
            elif body.report_type == "floors":
                title, sections = await gather_floors(conn, body.model_id)
            elif body.report_type == "foundations":
                title, sections = await gather_foundations(conn, body.model_id)
            elif body.report_type == "doors":
                title, sections = await gather_doors(conn, body.model_id)
            elif body.report_type == "windows":
                title, sections = await gather_windows(conn, body.model_id)
            else:  # "model_summary" — only remaining member of REPORT_TYPES
                snapshot_bytes = None
                if body.viewer_snapshot:
                    try:
                        snapshot_bytes = base64.b64decode(body.viewer_snapshot, validate=True)
                    except Exception:
                        raise HTTPException(status_code=400, detail="viewer_snapshot must be valid base64.")
                title, sections = await gather_model_summary(conn, body.model_id, snapshot_bytes)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    finally:
        release_conn(conn)

    from documents.office_export import build_docx_report, build_pdf_report, build_xlsx_report
    builder = {"docx": build_docx_report, "xlsx": build_xlsx_report, "pdf": build_pdf_report}[body.output_format]
    data = builder(title, sections)

    filename = body.filename or f"{body.report_type}-report-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    if not filename.lower().endswith(f".{body.output_format}"):
        filename = f"{filename}.{body.output_format}"

    if body.upload:
        from routers.documents import upload_document_bytes
        return await upload_document_bytes(body.stream_id, filename, data, body.doc_type, body.model_id, body.folder_path, user)

    return Response(
        content=data, media_type=_MIME[body.output_format],
        headers={"Content-Disposition": _content_disposition(filename)},
    )
