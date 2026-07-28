# API Reference & Project Structure

Detailed reference material split out of the main [README](../README.md) to keep that file focused on onboarding. See the README for architecture, setup, and the bcf-server/MCP docs.

---

## REST API reference (bim-normalizer)

All routes below are served by `bim-normalizer` (`:8002`). See [`bim-normalizer/config/settings.py`](../bim-normalizer/config/settings.py) for the routers each section maps to.

#### Ingest & sync

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Start async ingest job. Body: `{stream_id, commit_id, force?}` |
| `GET` | `/ingest/status/{job_id}` | Poll job status |
| `GET` | `/auto-sync/servers` | List servers watched for webhook-driven auto-sync |
| `POST` | `/auto-sync/servers` | Add/update a watched server. Enabling immediately triggers one scan rather than waiting for the periodic background pass |
| `POST` | `/auto-sync/scan` | Fire an on-demand scan of every enabled server. Called by the frontend once on app load so a brand-new project's webhook registers immediately |
| `POST` | `/webhooks/speckle/{webhook_row_id}` | Webhook receiver — Speckle calls this on `commit_create` (triggers ingest) as well as `stream_delete` / `commit_delete` / `branch_delete` (purges the matching local models and, for a deleted stream, their BCF topics too — Speckle is treated as the single source of truth) |

#### Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models` | List all ingested models |
| `GET` | `/models/{id}` | Model metadata + element count |
| `DELETE` | `/models/{id}` | Delete model and all associated data |
| `GET` | `/models/trend/{stream_id}` | Element/category counts across all versions of a stream |
| `GET` | `/models/by-stream/{stream_id}` | All ingested models for a given Speckle stream |
| `GET` / `POST` | `/projects/{stream_id}/model-status` | Get/set model status tracking (`bim_model_status`) |
| `POST` | `/projects/{stream_id}/models/delete-cleanup` | Bulk cleanup of models orphaned by a stream-side deletion |
| `POST` | `/projects/{stream_id}/models/upload-ifc` | Upload an `.ifc` file directly (bypassing Speckle) to ingest as a model. Returns `{upload_id}` |
| `GET` | `/projects/{stream_id}/models/upload-ifc/{upload_id}/status` | Poll direct-IFC-upload ingest job |

#### Elements

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| `GET` | `/models/{id}/elements` | `category`, `ifc_class`, `storey`, `name`, `speckle_id`, `limit`, `offset` | Filtered element list |
| `GET` | `/models/{id}/elements/flat` | same + `limit`, `offset` | Elements enriched with geometry + material/profile/grade |
| `GET` | `/models/{id}/elements/by-parameter` | parameter key/value filters | Elements matching arbitrary parameter values |
| `GET` | `/models/{id}/elements/nearby` | `speckle_id`, `radius_m` | Elements within a radius of a given element's centroid |
| `GET` | `/models/{id}/elements/semantic-search` | `query`, `limit` | Rank elements by meaning (cosine similarity over local embeddings) instead of exact text match — `[]` if the model predates this feature or the embed step failed at ingest |
| `GET` | `/elements/{element_id}` | — | Single element with all parameters and geometry |
| `GET` | `/models/{id}/parameters/keys` | — | Distinct parameter keys present on a model |
| `GET` | `/models/{id}/parameters/completeness` | — | Per-parameter fill-rate across elements |

#### Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/summary` | Count + volume + area by category, ifc_class, storey; material/profile/grade distributions |
| `GET` | `/models/{id}/qa` | Quality report: missing names, storeys, geometry, materials, duplicates; 0–1 score |
| `GET` | `/models/{id}/qa/elements` | Elements behind a specific QA issue |
| `GET` | `/diff/{model_a}/{model_b}` | Added / removed / changed elements + per-category deltas |
| `GET` | `/models/{id}/export/csv` | Export elements/parameters as CSV |

#### Filters & overrides

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/overrides` | List manual property overrides for a model |
| `POST` | `/models/{id}/overrides` | Create an override |
| `DELETE` | `/models/{id}/overrides/{override_id}` | Remove an override |
| `POST` | `/models/{id}/overrides/apply` | Apply pending overrides to stored elements |
| `POST` | `/models/{id}/filter-publish` | Start async job publishing a filtered element subset back to Speckle |
| `GET` | `/filter-publish/{job_id}/status` | Poll filter-publish job |
| `POST` | `/classification/reload` | Hot-reload `config/mapping_canonical.json` classification rules |

#### 4D Timeline & Schedule

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/timeline/params` | Discover date/sequence parameters for animation |
| `GET` | `/models/{id}/timeline/data` | Elements grouped by parameter value |
| `GET` | `/models/{id}/schedule` | Return full task tree with linked element `speckle_id`s for viewer sync |
| `DELETE` | `/models/{id}/schedule` | Delete the model's schedule (all tasks) |
| `POST` | `/models/{id}/schedule/import` | Import a schedule file (`multipart/form-data`). Accepts `.ifc` (IfcWorkSchedule) or `.xml` (MS Project XML / MSPDI) |
| `GET` | `/models/{id}/schedule/export-ifc` | Export the schedule as an IFC work schedule file |
| `POST` | `/models/{id}/schedule/tasks` | Create a task |
| `PATCH` | `/models/{id}/schedule/tasks/{task_id}` | Update a task |
| `DELETE` | `/models/{id}/schedule/tasks/{task_id}` | Delete a task |
| `POST` | `/models/{id}/schedule/tasks/{task_id}/elements` | Link elements to a task |
| `DELETE` | `/models/{id}/schedule/tasks/{task_id}/elements` | Unlink elements from a task |
| `POST` | `/models/{id}/schedule/dependencies` | Create/edit a predecessor→successor dependency (FS/SS/FF/SF + lag); rejects cycles with `422`. Triggers a CPM recompute (`db/cpm.py`) |
| `DELETE` | `/models/{id}/schedule/dependencies/{dependency_id}` | Delete a dependency; triggers a CPM recompute |

#### IFC Export & Quantities

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/models/{id}/export/ifc` | Start async IFC4X3 export. Returns `{job_id}` |
| `GET` | `/models/{id}/export/ifc/{job_id}/status` | Poll export job |
| `GET` | `/models/{id}/export/ifc/{job_id}/download` | Download `.ifc` file |
| `POST` | `/streams/{stream_id}/original-ifc` | Register the original uploaded `.ifc` blob so export can serve it directly instead of re-exporting |
| `GET` | `/models/{id}/quantities` | Quantity takeoff from DB — element count + volume (m³) + area (m²). `group_by` = `ifc_class` (default) \| `category` \| `storey` |

If the source is IFC, the original blob uploaded to the Speckle server is served directly — no re-export.

#### IDS checking

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/models/{id}/ids-specs` | Store an IDS specification (XML, built via the graph editor or hand-authored) |
| `GET` | `/models/{id}/ids-specs` | List stored IDS specs for a model |
| `GET` | `/models/{id}/ids-specs/{spec_id}` | Fetch one spec |
| `DELETE` | `/models/{id}/ids-specs/{spec_id}` | Delete a spec |
| `POST` | `/models/{id}/ids-check` | Run an IDS spec against the model via `ifctester`. Returns `{job_id}` |
| `GET` | `/models/{id}/ids-check/{job_id}/status` | Poll check job; results map failures to element `speckle_id`s for viewer highlight and optional BCF topic creation |

#### Clash detection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/models/{id}/clash-check` | Run BVH mesh-level clash detection via `ifcclash` (same engine as BlenderBIM/Bonsai). Body includes `rules[]` and an optional `compare_model_id` — when set, every rule's `selector_a` is checked against *this* model and `selector_b` against `compare_model_id` instead of the model against itself (cross-discipline clashes, e.g. structure vs architecture). Returns `{job_id}` |
| `GET` | `/models/{id}/clash-check/{job_id}/status` | Poll clash job; results map clashing pairs to element `speckle_id`s for viewer highlight and optional BCF topic creation. For a cross-model check, `ifc_source` is null and `compare` holds `{model_b_id, ifc_source_a, ifc_source_b}` instead |

#### AI Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/servers` | List configured Speckle servers (name/url/token) for the frontend's server-switcher dropdown — despite living under this section in the code, it has nothing to do with AI providers |
| `POST` | `/chat` | Agentic chat with BIM context. Body: `{model_id, message, history, ai_provider, ...}`. Returns `{text, elementIds, toolsUsed}` |
| `POST` | `/chat/stream` | Same as `/chat`, streamed (SSE) |

#### Auth

Dashboard login, backed by `bcf_users` accounts and signed by `DASHBOARD_SESSION_SECRET` (see `dashboard_auth/`). Skippable in dev via `DASHBOARD_AUTH_BYPASS`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/login` | Log in, sets the session cookie |
| `POST` | `/auth/logout` | Clear the session cookie |
| `GET` | `/auth/me` | Current session's user + role |

#### Documents (Nextcloud-backed)

All stream-scoped (`{stream_id}` = Speckle project id), like `bcf/topics.py`'s convention — a
document must survive re-ingestion, so it can't be pinned to one commit's `model_id`. The
approval gate is a three-stage ISO 19650 workflow — reviewed → approved → verified — each
stage independently settable/clearable and attributed to an actor, not a single flag.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/projects/{stream_id}/documents` | List documents. Optional `?status=` filter |
| `GET` | `/projects/{stream_id}/documents/{doc_id}` | Metadata + audit event history |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/download` | Proxied file download — browser never sees Nextcloud credentials |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/thumbnail` | Proxied preview; 404 for formats Nextcloud can't preview (most CAD) |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/preview.dxf` | `.dwg` only — converts to DXF server-side (`dwg2dxf`) for the frontend's DXF viewer |
| `POST` | `/projects/{stream_id}/documents/upload` | Multipart upload — always lands in `01_WIP` |
| `POST` | `/projects/{stream_id}/documents/{doc_id}/move` | Body: `{status, actor}`. `409` if moving to Published while unapproved — the app-enforced gate |
| `POST` / `DELETE` | `/projects/{stream_id}/documents/{doc_id}/review` | Set/clear the reviewed stage |
| `POST` / `DELETE` | `/projects/{stream_id}/documents/{doc_id}/approve` | Set/clear the approved stage |
| `POST` / `DELETE` | `/projects/{stream_id}/documents/{doc_id}/verify` | Set/clear the verified stage |
| `POST` | `/projects/{stream_id}/documents/{doc_id}/revise` | Upload a new version — status unchanged, approval reset, Nextcloud auto-versions the prior content |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/versions` | List prior versions (Nextcloud's WebDAV versions API) |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/versions/{version_id}/download` | Download one prior version |
| `DELETE` | `/projects/{stream_id}/documents/{doc_id}` | Nextcloud delete + local soft-delete tombstone (audit trail survives) |
| `POST` / `DELETE` | `/projects/{stream_id}/documents/{doc_id}/link-topic` \| `/link-element` | Link to a BCF topic or model element (backend only so far — no dedicated UI yet) |
| `POST` | `/projects/{stream_id}/documents/backfill` | One-time bulk-index of files already in Nextcloud. Returns `{job_id}` |
| `GET` | `/projects/{stream_id}/documents/backfill/{job_id}/status` | Poll backfill job |
| `GET` | `/projects/{stream_id}/my-roles` | Current user's ISO 19650 author/reviewer/approver roles on this project |
| `GET` | `/projects/{stream_id}/documents/linked-positions` | Positions (elements/topics) already linked to at least one document, for UI badge display |

#### Dashboard layout & sharing

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `PUT` | `/dashboard-layout/{project_id}` | Persist the drag-and-drop widget layout per project |
| `POST` / `GET` | `/share` | Create / list shareable dashboard snapshots |
| `GET` / `DELETE` | `/share/{share_id}` | Fetch or revoke a share link |

#### Utility & Debug

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{"status": "ok", "service": "bim-normalizer"}` |
| `GET` | `/debug/inspect/{stream_id}/{commit_id}` | Geometry coverage analysis without storing |
| `POST` | `/debug/classify-inspect` | Show classification signals for first N elements |

---

## Project structure

```
converge/
├── src/
│   ├── App.jsx                        Main application, data loading, routing
│   ├── main.jsx                       React entry point
│   ├── index.css                      Global styles
│   ├── components/
│   │   ├── SpeckleViewer.jsx
│   │   ├── AdaptiveCharts.jsx
│   │   ├── EChart.jsx                 ECharts/core wrapper component
│   │   ├── AdaptiveMetrics.jsx
│   │   ├── ElementTable.jsx
│   │   ├── ElementPanel.jsx
│   │   ├── PivotTableWidget.jsx
│   │   ├── QuantityWidget.jsx         5D quantity takeoff visualisation
│   │   ├── ScheduleWidget.jsx         Gantt-style schedule viewer
│   │   ├── ValidationWidget.jsx
│   │   ├── FilterWidget.jsx
│   │   ├── ActiveFilters.jsx
│   │   ├── ClashCheckPanel.jsx        ifcclash results + viewer highlight
│   │   ├── ClashLogoIcon.jsx
│   │   ├── IdsCheckPanel.jsx          ifctester IDS validation results
│   │   ├── IdsGraphEditor.jsx         Visual IDS spec authoring (xyflow)
│   │   ├── idsGraphNodeTypes.jsx
│   │   ├── IdsLogoIcon.jsx
│   │   ├── BcfTopicPanel.jsx          BCF topic list/detail
│   │   ├── BcfKanbanBoard.jsx         BCF topic Kanban board
│   │   ├── BcfStatsWidget.jsx
│   │   ├── BcfLogoIcon.jsx
│   │   ├── DocumentsPanel.jsx         Nextcloud document workflow (WIP/Shared/Published/Archived)
│   │   ├── DocumentPreview.jsx        PDF/IFC/DXF preview dispatcher overlay
│   │   ├── document-preview/
│   │   │   ├── IfcCanvas.jsx          web-ifc + Three.js 3D viewer
│   │   │   ├── DxfCanvas.jsx          dxf-viewer (WebGL/Three.js)
│   │   │   ├── DocxCanvas.jsx         docx-preview, renders to HTML/CSS
│   │   │   └── XlsxCanvas.jsx         SheetJS xlsx, sheet_to_html per sheet
│   │   ├── ChatWidget.jsx
│   │   ├── MarkdownWidget.jsx         Editable markdown notes panel
│   │   ├── MetricsConfig.jsx          Threshold config for AdaptiveMetrics
│   │   ├── DiffBar.jsx
│   │   ├── TimelinePlayer.jsx
│   │   ├── DashboardGrid.jsx          Drag-and-drop resizable widget grid
│   │   ├── WidgetFAB.jsx
│   │   ├── ViewerToolbar.jsx          3D viewer action toolbar
│   │   ├── ChartBuilder.jsx
│   │   ├── chartSettingsUI.jsx
│   │   ├── StandaloneChartWidget.jsx
│   │   ├── BreadcrumbSelector.jsx
│   │   ├── CompareVersionToggle.jsx
│   │   ├── IngestProgress.jsx
│   │   ├── PublishSelectionButton.jsx
│   │   ├── VideoWidget.jsx
│   │   ├── IfcLogoIcon.jsx            IFC logo SVG (used as export button)
│   │   ├── ErrorBoundary.jsx          Per-widget React error boundary
│   │   ├── LoginScreen.jsx            Dashboard login screen
│   │   ├── SpeckleModelsList.jsx      Browsable project/model list
│   │   ├── CombineModelsPicker.jsx    Federated (multi-model) selection
│   │   ├── FederatedBar.jsx           Federated view status bar
│   │   ├── FederatedClashPanel.jsx    Cross-model clash checking
│   │   ├── ViewpointMarkupEditor.jsx  Markup a 3D viewpoint before attaching to a BCF topic
│   │   ├── PanoramaThumbnail.jsx      360°/panorama image thumbnail
│   │   ├── SchedulePanel.jsx          Native 4D planner drawer (Gantt + Playback tabs)
│   │   ├── ScheduleGanttView.jsx      WBS/Gantt authoring, dependencies, critical path
│   │   ├── SchedulePlaybackView.jsx   4D build-up playback scrubber
│   │   └── ...
│   ├── contexts/
│   │   └── AuthContext.jsx            Dashboard auth state (login/session)
│   ├── lib/
│   │   ├── echarts.js                 Central ECharts registration (tree-shaken chart types)
│   │   └── echartsTheme.js            Shared dark/light theme builders for chart options
│   └── utils/
│       ├── speckleContextBuilder.js   Builds AI context from model data
│       ├── propertyScanner.js         Scans object trees for property keys
│       ├── filterRules.js             Rule evaluation shared by FilterWidget/viewer/filter-publish
│       ├── bcfClient.js               BCF-API REST client used by all BCF/clash/IDS panels
│       ├── bcfSync.js                 Syncs BCF topic state with viewer selection/highlight
│       ├── bcfWorkflow.js             BCF status transition rules
│       ├── idsTemplates.js            Built-in IDS specification templates
│       ├── idsGraphToXml.js           IDS graph editor → IDS 1.0 XML (clean-room, no AGPL deps)
│       ├── idsXmlToGraph.js           IDS 1.0 XML → graph editor nodes
│       ├── useDrawerWidth.js          Hook for resizable side-drawer width
│       ├── dxfViewerWorker.js         Web Worker for dxf-viewer parsing
│       ├── speckleGraphQL.js          Speckle GraphQL query helpers
│       └── useAuthedImage.js          Hook for fetching auth-gated images (e.g. Nextcloud thumbnails)
│
├── bim-normalizer/
│   ├── main.py                        FastAPI app: lifespan, middleware, /health, router wiring
│   ├── job_registry.py                UUID validation + Content-Disposition header helpers shared by routers (job state itself lives in db/jobs.py, not here)
│   ├── speckle_mcp.py                 MCP server (72 tools + 2 resources)
│   ├── bcf_server.py                  BCF-API 2.1/3.0 server (separate process/container)
│   ├── clash_check.py                 Clash detection via ifcclash
│   ├── ids_check.py                   IDS validation via ifctester
│   ├── dwg_convert.py                 .dwg -> .dxf via LibreDWG's dwg2dxf (subprocess), for document preview only
│   ├── dxf_thumbnail.py               DXF thumbnail generation for document preview
│   ├── pdf_thumbnail.py               PDF thumbnail generation for document preview
│   ├── process_pool.py                Shared worker process pool for CPU-bound jobs (export, checks, thumbnails)
│   ├── nextcloud/                     WebDAV/OCS client, provisioning, group folders, drift-detector reconciliation
│   ├── dashboard_auth/                Dashboard login session handling (session.py, dependencies.py)
│   ├── Dockerfile                     Python 3.11 image (shared by normalizer/MCP/BCF) — also builds LibreDWG from source
│   ├── docker-compose.yml             normalizer + speckle-mcp services (standalone dev compose)
│   ├── requirements.txt
│   ├── .env                           secrets (not committed)
│   ├── npm-mcp-setup.md               NPM reverse proxy setup guide
│   ├── testing-semantic-search.md     How to verify semantic search + agentic QA/element tools
│   ├── testing-clash-schedule-resources.md  How to verify clash/schedule tools, caching, resources
│   ├── testing-documents.md           How to verify the Nextcloud document workflow
│   ├── routers/                       One APIRouter module per REST API reference section above
│   │   ├── dashboard.py, sync.py, chat.py, ingest.py, models.py, elements.py   Share links/layout, Speckle server config, AI chat, ingest, models, elements
│   │   ├── analytics.py, timeline.py, debug.py, overrides.py                  Diff/summary/QA/CSV, 4D timeline/schedule, debug inspectors, classification overrides
│   │   ├── filter_publish.py, ifc_export.py, ids_check.py, clash_check.py     Filter-publish, IFC export/quantities, IDS checking, clash detection
│   │   ├── auth.py                                                           Dashboard login (/auth/login, /auth/logout, /auth/me)
│   │   └── documents.py                                                      Nextcloud-backed document workflow (see Documents API reference above)
│   ├── bcf/
│   │   ├── projects.py, topics.py, comments.py, viewpoints.py   Core BCF-API routers
│   │   ├── auth.py, auth_discovery.py                            Bearer auth + discovery
│   │   ├── foundation.py                                         OpenCDE Foundation API (/foundation/{version}/auth)
│   │   ├── oauth.py                                              Real OAuth2/OIDC login against bcf_users, for BIMcollab ZOOM/Solibri
│   │   ├── users.py, password.py                                 bcf_users CRUD + bcrypt hashing
│   │   ├── admin.py                                              Standalone admin page (/admin) — users, sessions, models, extensions, request log
│   │   ├── request_log.py                                        In-memory ring buffer of recent HTTP requests, surfaced in admin.py
│   │   ├── bridge.py                                             Speckle stream_id ↔ model_id resolution
│   │   ├── bcfxml.py                                             .bcfzip import/export
│   │   ├── db.py, db_schema.py                                   BCF Postgres schema + queries
│   │   ├── schemas.py                                            Pydantic models
│   │   └── versions.py                                           BCF version constants + is_bcf_v3() request-path detection
│   ├── chat/
│   │   └── agent.py                   Agentic chat backend (LLM + DB tools)
│   ├── pipeline/
│   │   └── normalize.py               Ingest pipeline orchestrator (incl. best-effort embedding step)
│   ├── search/
│   │   └── embeddings.py              Local CPU embedding model (fastembed) + cosine similarity for semantic search
│   ├── speckle/
│   │   ├── fetch.py                   Speckle commit fetch + element flattening
│   │   ├── client.py                  SpecklePy client wrapper
│   │   ├── publish.py                 Filter-publish back to Speckle
│   │   └── webhooks.py                Backend-driven auto-sync webhook registration
│   ├── ifc/
│   │   ├── classify.py                speckle_type + properties → IFC class/category
│   │   ├── geometry.py                Mesh extraction, bbox, centroid, volume
│   │   ├── spatial.py                 Storey detection, applicationId extraction
│   │   ├── export.py                  IFC4X3 file generation
│   │   └── schema.py                  IFC schema helpers
│   ├── db/
│   │   ├── models.py                  PostgreSQL schema (CREATE TABLE statements)
│   │   ├── connection.py              Connection pool
│   │   ├── insert.py                  Upsert helpers
│   │   ├── query.py                   Summary, QA, flat element queries
│   │   ├── jobs.py                    DB-backed async job tracking (bim_jobs table)
│   │   ├── purge.py                   Deletes local models (+ cascaded data) mirroring a Speckle-side deletion
│   │   ├── timeline.py                4D parameter discovery
│   │   ├── schedule.py                4D schedule: IFC work schedule + MS Project XML (MSPDI) import, task/dependency CRUD
│   │   ├── cpm.py                     Critical Path Method engine (forward/backward pass, float, critical path)
│   │   ├── roles.py                   ISO 19650 author/reviewer/approver role checks
│   │   └── model_status.py            Model/document status tracking
│   └── config/
│       └── settings.py                Environment variable loading
│
├── public/                            Static assets: logos/icons, fonts/, wasm/ (web-ifc, web-ifc-mt)
├── nextcloud-hooks/                   post-installation/ — auto-installs groupfolders on first Nextcloud boot
├── postgres-init/                     01-nextcloud-db.sh — creates Nextcloud's DB on a fresh Postgres volume
├── docker-compose.yml                 Full stack: postgres, bim-normalizer, speckle-mcp, bcf-server, dashboard
├── Dockerfile                         Frontend build (Vite) + nginx serve
├── nginx.conf.template                Proxies /normalizer/ and /bcf/ to backend containers
├── .mcp.json                          MCP server registration (Claude Code)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── README.md
```
