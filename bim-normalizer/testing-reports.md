# Testing report generation

Covers `reports/generate.py` (the shared gatherer — single source of truth
for all 19 report types), `documents/office_export.py` (renders the shared
`(title, sections)` IR to `.docx`/`.xlsx`/`.pdf`), and the three surfaces
that call it: `routers/reports.py`'s REST endpoint, `chat/agent.py`'s
`generate_report` tool, and `converge_mcp.py`'s `speckle_generate_report`.

This repo has no `tests/`/`test_*.py` for the report path — verification is
manual, following the same convention as `testing-documents.md` etc.

`POST /reports/generate` requires a logged-in session (`Depends(require_login)`)
— pass a real session cookie, not just `BCF_API_KEY`. `GET /reports/types` is
unauthenticated (read-only metadata for the frontend's picker).

## 1. Discover report types

```bash
curl -s "http://<host>:<port>/reports/types" | python3 -m json.tool
```

Confirm all 19 are present: `bom`, `qa`, `clashes`, `ids`, `documents`,
`rooms`, `schedule`, `changes`, `bcf`, `anomalies`, `concrete_beams`,
`steel_beams`, `walls`, `columns`, `floors`, `foundations`, `doors`,
`windows`, `model_summary` — each with the right `needs` list (e.g.
`clashes` needs `model_id` + `rules`, `changes` needs `model_id` +
`compared_model_id`, `ids` needs `model_id` + `spec_id`).

## 2. Generate each output format

Pick any report that only needs `model_id` (e.g. `bom`, `doors`,
`model_summary`) and confirm all three formats produce a real, non-empty
file — not just a 200 with garbage bytes:

```bash
for fmt in pdf docx xlsx; do
  curl -s -b cookies.txt -X POST "http://<host>:<port>/reports/generate" \
    -H "Content-Type: application/json" \
    -d "{\"report_type\":\"model_summary\",\"model_id\":\"<model_id>\",\"output_format\":\"$fmt\"}" \
    -o "out.$fmt"
  file "out.$fmt"   # pdf: "PDF document"; docx/xlsx: "Zip archive data" (both are zip containers)
done
```

```python
# pdf: at minimum confirm it's a real, parseable PDF
import subprocess
assert open("out.pdf", "rb").read(5) == b"%PDF-"

# docx/xlsx: both are zip archives — confirm they open and have the expected
# internal structure rather than just checking the outer zip is valid
import zipfile
with zipfile.ZipFile("out.docx") as z:
    assert "word/document.xml" in z.namelist()
with zipfile.ZipFile("out.xlsx") as z:
    assert "xl/workbook.xml" in z.namelist()
```

## 3. Branding + page numbers (PDF)

Open the generated PDF and confirm: Converge logo + "Converge" wordmark
top-left on **every** page (not just the first — `_draw_pdf_branding` is
registered as both `onFirstPage` and `onLaterPages`), and "Page N"
bottom-right on every page. A report with enough rows to span 2+ pages
(e.g. `model_summary` against a model with a large `by_storey` breakdown,
or `bcf` against a project with many topics) is the only way to actually
confirm the header/footer repeats rather than just appearing once.

## 4. `model_summary`'s 3D view (frontend-only — no REST equivalent)

The backend has no rendering capability of its own — a white-background 3D
view only appears if the caller supplies `viewer_snapshot` (base64 PNG).
The only real source for this is `SpeckleViewer.jsx`'s `captureScreenshot()`
method, wired into `DocumentsPanel.jsx`'s Generate Report flow:

1. Open a project with a model loaded in the 3D viewer.
2. Documents panel → Generate Report → Model Summary → PDF → Generate.
3. Confirm the resulting PDF has a "3D View" section near the top with a
   real image (not blank), **white** background (not the app's dark theme
   default), before the Model Information/Quantities/Charts/table sections.
4. Generating `model_summary` via `curl`/chat/MCP (no live viewer) should
   still succeed — just without a "3D View" section at all, not an error.

## 5. Charts (`model_summary` only)

Confirm the "Charts" section renders **before** the By Category/By IFC
Class tables: a pie chart (element count by category, top 8 + "Other"
bucket) and a horizontal bar chart (element count by IFC class, top 10).
Charts are rendered as their own images-only section deliberately separate
from the table sections — `build_xlsx_report` picks table *or* images per
section, not both, so a combined section would silently drop the chart on
the xlsx sheet even though docx/pdf render both fine. Confirm the xlsx
output actually has the charts on their own "Charts" sheet, not missing.

## 6. `upload: true` — lands in the project's CDE

```bash
curl -s -b cookies.txt -X POST "http://<host>:<port>/reports/generate" \
  -H "Content-Type: application/json" \
  -d '{"report_type":"bom","model_id":"<model_id>","stream_id":"<stream_id>","output_format":"pdf","upload":true}'
```

Requires an author/reviewer/approver role on `stream_id` (`require_project_role`)
— confirm a user with no role on that project gets a `403`, not a silent
success. On success, confirm the returned document metadata matches a real
new row in the Documents panel's WIP folder, with the expected filename
pattern `{report_type}-report-{YYYYMMDD-HHMMSS}.{ext}`.

## 7. Cross-surface consistency

Generate the same report type + `model_id` via all three surfaces (REST
`curl`, the in-app AI chat assistant, `speckle_generate_report` via MCP) and
confirm the content matches — they all call the exact same `reports/generate.py`
gatherer, so any difference means one surface is passing the wrong
arguments through, not a gatherer bug.

## 8. IDS report — rule-set picker, not a raw `spec_id`

The Documents panel's Generate Report → IDS Compliance Report no longer
takes a free-text `spec_id` — it's a dropdown populated live from
`GET /models/{model_id}/ids-specs` (the same list the IDS Editor's own
picker uses). Confirm: opening the picker with no saved IDS specs on the
loaded model shows a helpful "no saved rule sets" message instead of an
empty/broken dropdown, and that generating against a real saved spec
produces a report whose Summary section matches what `POST
/models/{id}/ids-check` returns for the same spec directly.
