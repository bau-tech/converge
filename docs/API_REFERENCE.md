# API Reference & Project Structure

Detailed reference material split out of the main [README](../README.md) to keep that file focused on onboarding: the full REST API, database schema, bcf-server module map, frontend component list, environment variables, and annotated project structure. See the README for architecture, quick start, and MCP setup — and [`docs/MCP_REFERENCE.md`](MCP_REFERENCE.md) for the full MCP tool catalog.

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
| `POST` | `/webhooks/speckle/{webhook_row_id}` | Webhook receiver — Speckle calls this on `commit_create` (triggers ingest) as well as `stream_delete` / `commit_delete` / `branch_delete` (purges the matching local models, and for a deleted stream also its BCF topics, document roles/status, documents, and Nextcloud group folder — `db/purge.py`'s `purge_speckle_models`/`purge_project_documents`, same teardown the reconciliation scan and the admin panel's manual purge share. Speckle is treated as the single source of truth) |

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
| `POST` | `/models/{id}/schedule/import` | Import a schedule file (`multipart/form-data`). Accepts `.ifc` (IfcWorkSchedule), `.xml` (MS Project XML / MSPDI), or `.csv` |
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

#### bSDD (buildingSMART Data Dictionary)

Server-side proxy powering the IDS graph editor's property/classification pickers — bSDD's public API answers cross-origin browser requests with an empty 200 body (no CORS headers), so the frontend can't call it directly. `routers/bsdd.py` calls it server-to-server and caches responses (1 hour TTL; the underlying dictionary/class/property data changes on the order of months, not requests).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bsdd/dictionaries` | List all bSDD dictionaries (cached whole, filtered server-side) |
| `GET` | `/bsdd/classes` | Search bSDD classes (e.g. IFC entities) within a dictionary |
| `GET` | `/bsdd/entity-properties` | Property sets + properties bSDD associates with an IFC class |

#### Clash detection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/models/{id}/clash-check` | Run BVH mesh-level clash detection via `ifcclash` (same engine as BlenderBIM/Bonsai). Body includes `rules[]` and an optional `compare_model_id` — when set, every rule's `selector_a` is checked against *this* model and `selector_b` against `compare_model_id` instead of the model against itself (cross-discipline clashes, e.g. structure vs architecture). Returns `{job_id}` |
| `GET` | `/models/{id}/clash-check/{job_id}/status` | Poll clash job; results map clashing pairs to element `speckle_id`s for viewer highlight and optional BCF topic creation. For a cross-model check, `ifc_source` is null and `compare` holds `{model_b_id, ifc_source_a, ifc_source_b}` instead |

#### Reports

Shared with the AI chat assistant's report tool and the MCP server's `speckle_generate_report` (which calls this endpoint rather than reimplementing the gatherers) — one implementation (`reports/generate.py`), three surfaces, so all three always produce identical content.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reports/types` | List all 19 report types and which id(s)/params each needs (`model_id`, `stream_id`, `compared_model_id`, `rules`, `spec_id`) — lets the frontend's picker show/hide inputs without hardcoding the list |
| `POST` | `/reports/generate` | Generate one of `bom` \| `qa` \| `clashes` \| `ids` \| `documents` \| `rooms` \| `schedule` \| `changes` \| `bcf` \| `anomalies` \| `concrete_beams` \| `steel_beams` \| `walls` \| `columns` \| `floors` \| `foundations` \| `doors` \| `windows` \| `model_summary` as a real `.docx`/`.xlsx`/`.pdf` file (`output_format`). Returns the file directly (default), or uploads it into the project's CDE WIP folder and returns the created document's metadata if `upload: true` (requires an author/reviewer/approver role). `model_summary` accepts an optional `viewer_snapshot` (base64 PNG) captured client-side from the live 3D viewer for its white-background 3D-view section — the backend has no rendering capability of its own |

Every generated file gets a Converge-branded header (logo + page numbers on every PDF page) via `documents/office_export.py`, which renders the shared `(title, sections)` IR to all three output formats from one gatherer.

#### AI Chat

An agentic tool-calling loop (`chat/agent.py`) over BIM/CDE data — up to `MAX_TOOL_ROUNDS` (10) tool
rounds per user turn, each round highlighting matched elements in the 3D viewer via the response's
`elementIds`. `ai_provider` selects one of `openai` / `anthropic` / `mistral` / `ollama` / `lmstudio`
(with a matching `*_config` body key — `openai_config`, `anthropic_config`, etc. — carrying
`apiKey`/`model`/`baseUrl` as applicable); OpenAI/Anthropic/Mistral/Ollama/LM Studio all funnel through
one provider-agnostic tool-dispatch loop, with the Anthropic Messages API's different wire shape
(`system` field, `input_schema` tools, `content` blocks, collapsed `tool_result` messages) translated
at the request/response boundary only (`_call_llm_anthropic`/`_call_llm_stream_anthropic`).

Auth on `/chat` and `/chat/stream` is **optional, not required** — these routes intentionally also
serve anonymous `/shareXXX` visitors (see `App.jsx`'s auth-gate comment). A logged-in user
additionally gets ISO 19650 org-scoped WIP visibility in `list_documents`/`get_document_status`
results (same scoping `GET .../documents` enforces, see Documents below) and a working
`get_notifications` tool; an anonymous session sees only unscoped WIP and gets a graceful
"requires being logged in" message from `get_notifications` instead of a guess or an error.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/servers` | List configured Speckle servers (name/url/token) for the frontend's server-switcher dropdown — despite living under this section in the code, it has nothing to do with AI providers |
| `POST` | `/chat` | Agentic chat with BIM context. Body: `{model_id, message, history, ai_provider, ...}`. Returns `{text, elementIds, toolsUsed}` |
| `POST` | `/chat/stream` | Same as `/chat`, streamed (SSE): `reasoning` / `tool_start` / `tool_done` / `text_delta` / `elements` / `done` events |

**Tool catalog** (`_TOOLS` in `chat/agent.py`) — every tool highlights its matched elements in the
viewer unless noted otherwise:

| Tool | Description |
|------|-------------|
| `filter_elements` | Highlight elements by category, ifc_class, storey, name |
| `get_summary` | Aggregate counts/volumes grouped by category, storey, or ifc_class |
| `query_by_parameter` | Find elements by any parameter key/value; numeric ops (gt/lt/gte/lte) |
| `get_materials` | List materials with element counts and volumes |
| `get_profiles` | List structural profiles and steel grades |
| `estimate_cost` | Apply user-supplied unit rates to quantities for a rough cost estimate |
| `get_model_changes` | Diff current model against another version (added/removed/changed) |
| `check_data_quality` | BIM QA score + issue breakdown (missing names/storeys/materials/geometry, duplicates) |
| `get_qa_elements` | Drill into one data-quality issue and highlight the affected elements |
| `get_parameter_completeness` | Fill-rate % per parameter, worst-covered first |
| `get_version_history` | Element-count/volume/area trend across every ingested version |
| `get_schedule` | 4D schedule tasks (status, critical path, float) and dependencies, filterable by status/critical/milestone |
| `get_element_tasks` | Which schedule tasks a specific element is linked to |
| `find_nearby_elements` | Elements within a radius (m) of a reference element or coordinate |
| `get_related_elements` | One-hop parent/room/space relationships (host wall, room contents) |
| `get_connectivity` | Multi-hop connectivity graph — IFC relationships plus geometric touching |
| `get_element_details` | Full details (geometry, all parameters) for one element |
| `semantic_search` | Find elements by meaning/description rather than exact text match |
| `check_clashes` | Geometric clash detection between two categories/IFC classes within this model |
| `check_federated_clashes` | Geometric clash detection between this model and a *different* model — only the current model's elements are highlightable |
| `list_ids_specs` / `check_ids_compliance` | buildingSMART IDS spec compliance checking |
| `list_documents` / `get_document_status` | CDE document status, approval gates, suitability code, folder, and linked element — read-only, org-scoped WIP visibility |
| `list_topics` / `get_topic` / `create_topic` / `update_topic` / `list_topic_comments` / `add_topic_comment` | BCF coordination issues — log/track/discuss findings as trackable topics |
| `get_notifications` | The logged-in user's notifications for this project — unavailable when anonymous |

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
| `PATCH` | `/projects/{stream_id}/documents/{doc_id}/suitability` | Body: `{code}`. Set the ISO 19650 "purpose of issue" suitability code (S0-S4/A1/A2/B1/B2/C1/D1) — approver only |
| `POST` | `/projects/{stream_id}/documents/{doc_id}/revise` | Upload a new version — status unchanged, approval + suitability reset, Nextcloud auto-versions the prior content |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/versions` | List prior versions (Nextcloud's WebDAV versions API) |
| `GET` | `/projects/{stream_id}/documents/{doc_id}/versions/{version_id}/download` | Download one prior version |
| `DELETE` | `/projects/{stream_id}/documents/{doc_id}` | Nextcloud delete + local soft-delete tombstone (audit trail survives) |
| `POST` / `DELETE` | `/projects/{stream_id}/documents/{doc_id}/link-topic` \| `/link-element` | Link to a BCF topic or model element (backend only so far — no dedicated UI yet) |
| `POST` | `/projects/{stream_id}/documents/backfill` | One-time bulk-index of files already in Nextcloud. Returns `{job_id}` |
| `GET` | `/projects/{stream_id}/documents/backfill/{job_id}/status` | Poll backfill job |
| `GET` | `/projects/{stream_id}/my-roles` | Current user's ISO 19650 author/reviewer/approver roles on this project |
| `GET` | `/projects/{stream_id}/documents/linked-positions` | Positions (elements/topics) already linked to at least one document, for UI badge display |

`GET .../documents` and every single-document route additionally enforce ISO 19650 contractual-container
separation: a WIP-status document tagged to an organization (`org_id`, set from the uploader's org at
upload time) is invisible to a viewer in a different org — 404, not 403, so existence isn't leaked. An
unscoped viewer or an unscoped document (the default until organizations are configured) stays visible
to everyone. Shared/Published/Archived documents are never org-filtered. See `bcf-server/admin` for
managing organizations and assigning users to one.

#### Notifications

Personal to the logged-in user across every project (not stream-scoped). Written by
`notifications/dispatch.py`, fired in the background right after a document is moved to Shared,
reviewed, approved, verified, given a suitability code, or revised — see the recipient table in
`notifications/dispatch.py`. Also emailed if `SMTP_HOST` is configured (optional, see Environment
variables below); otherwise in-app only.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/notifications` | List, newest first. Optional `?unread_only=true&limit=` |
| `GET` | `/notifications/unread-count` | `{count}` — polled by the dashboard's bell icon |
| `POST` | `/notifications/{id}/read` | Mark one notification read |
| `POST` | `/notifications/read-all` | Mark every unread notification read |

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

## Database schema (bim-normalizer)

```
bim_models          stream_id, commit_id, branch_name, source, author, ingested_at
  └── bim_elements  application_id, speckle_id, ifc_class, category, name, storey, hash
        ├── bim_geometry            bbox, centroid, volume_m3, area_m2, mesh (JSONB)
        ├── bim_parameters          pset, key, value, datatype
        ├── bim_relationships       element_id → related_id, relation_type
        └── bim_element_embeddings  embed_text, embedding (FLOAT[]) — semantic search, search/embeddings.py

bim_model_status     stream_id-scoped model/document status tracking (db/model_status.py)

bim_tasks            4D schedule tasks — name, dates, IFC/MSPDI/CSV-imported or manually created (db/schedule.py)
  ├── bim_task_elements      task_id ↔ element_id links, for viewer sync
  └── bim_task_dependencies  task_id → predecessor_id (schedule sequencing)

bcf_*                projects, topics, comments, viewpoints (BCF-API 2.1/3.0 schema, bcf/db_schema.py)

bim_jobs             job_id, job_type, status, payload, result, error (async job state — ingest/export/
                     filter-publish/IDS-check/clash-check/document-backfill — DB-backed so a backend
                     restart doesn't strand a polling client with an unrecoverable 404, db/jobs.py)

bim_documents         stream_id-scoped (survives re-ingestion, unlike model_id), Nextcloud-backed
                     document metadata — status (WIP/Shared/Published/Archived), doc_type
                     (document/drawing), a reviewed/approved/verified triad (each with its own
                     *_by/*_at attribution), revision, linked_bcf_topic, linked_element,
                     naming_compliant/naming_fields (advisory ISO 19650 filename check,
                     naming/iso19650.py), suitability_code (ISO 19650 purpose-of-issue,
                     naming/suitability.py — reset on every revision, like the gate triad),
                     org_id (ISO 19650 contractual-container separation — soft ref to
                     bcf_organizations, set from the uploader's org; gates WIP visibility only)
                     (db/documents.py, nextcloud/)
  └── bim_document_events  append-only audit trail — created/moved/reviewed/approved/verified/suitability_set/revised/deleted/linked

bim_document_roles   stream_id-scoped author/reviewer/approver RBAC backing the /my-roles endpoint

bim_notifications    in-app notification feed for document-workflow events — user_guid, stream_id,
                     doc_id, event_type, message, read_at (db/notifications.py, notifications/)

bim_dashboard_layouts        per-project drag-and-drop widget layout (GET/PUT /dashboard-layout)
bim_classification_overrides manual property overrides (POST /models/{id}/overrides)
bim_ids_specs                stored IDS specifications (POST /models/{id}/ids-specs)
auto_sync_servers            watched Speckle servers for webhook-driven auto-sync (GET/POST /auto-sync/servers)
stream_webhooks               registered Speckle webhook rows (speckle/webhooks.py)

bcf_organizations    a user's employer/company (ISO 19650 contractual-container separation) — name,
                     created_at (bcf/db_schema.py). bcf_users.org_id soft-links into this table
                     (nullable, ON DELETE SET NULL — unscoped is always a safe fallback)
```

---

## bcf-server modules

A standalone FastAPI process (`bcf_server.py`, same `bim-normalizer/` build context, separate container — mirrors how `converge-mcp` is wired) implementing the [BCF-API](https://github.com/buildingSMART/BCF-API) spec for issue tracking, mounted under both `/bcf/2.1` and `/bcf/3.0` since BIMcollab ZOOM only understands 2.1. Shares the same Postgres instance as bim-normalizer (`bcf_*` tables, initialised by `bcf/db_schema.py`).

`bcf/projects.py` and `bcf/topics.py` share their router instances across both version mounts (`bcf_server.py`'s prefix loop), but the 2.1 and 3.0 schemas aren't identical — confirmed against the official `release_2_1`/`release_3_0` branches of the BCF-API spec, two fields differ and are branched at request time via `bcf.versions.is_bcf_v3(request)`: the assignable-users list in `GET .../extensions` is `user_id_type` in 2.1 but `users` in 3.0, and 3.0's `topic_GET`/`topic_POST` responses additionally require a `server_assigned_id` string (sourced from the otherwise-unused `"index"` column, backfilled for pre-existing rows by `BACKFILL_INDEX_SQL`). Getting either of these wrong under `/bcf/3.0/` is what made 3.0-based BIMcollab Manager plugins show "no assignable team members" when creating an issue, even though the same data is fine over `/bcf/2.1/`.

| Module | Responsibility |
|--------|-----------------|
| `bcf/projects.py`, `bcf/topics.py`, `bcf/comments.py`, `bcf/viewpoints.py` | Core BCF-API resource routers |
| `bcf/auth.py`, `bcf/auth_discovery.py` | Bearer-token auth + the `/auth` discovery endpoint |
| `bcf/foundation.py` | OpenCDE Foundation API (`/foundation/{version}/auth`) — BCF 3.0 is an OpenCDE API and some clients look here before falling back to `/bcf/{version}/auth` |
| `bcf/users.py` (`/bcf-bridge/users`) | `bcf_users` CRUD, backing both the admin panel and OAuth login |
| `bcf/password.py` | bcrypt password hashing/verification for `bcf_users` |
| `bcf/oauth.py` | Real OAuth2/OIDC login against `bcf_users` — some clients (confirmed: BIMcollab ZOOM) refuse the spec's Basic-Auth fallback and require a real-looking Authorization Code + PKCE flow with an `openid` scope. Issued tokens/sessions are in-memory only (lost on every restart) |
| `bcf/admin.py` (`/admin`) | Standalone session-cookie-authenticated admin page (plain HTML/JS, no build step), gated on `bcf_users.is_admin = TRUE` (not just a valid login — every non-admin `bcf_users` row defaults to `is_admin = FALSE`, so a fresh deployment needs `BCF_ADMIN_EMAIL`/`BCF_ADMIN_PASSWORD` seeded to have anyone who can log in at all; an existing admin can promote/demote others from the panel's Users tab, `PATCH /admin/api/users/{guid}/admin`, which refuses to let an admin remove their own access) — manage `bcf_users` (including their ISO 19650 `bcf_organizations` membership, gating WIP document visibility), manage organizations themselves, view/revoke active OAuth sessions, browse ingested models with their BCF topics (incl. snapshot thumbnails) and per-project `bcf_extensions` value lists, purge a single model/version, or fully purge a project (models, BCF topics, document roles/status, documents — actual files deleted too — and the Nextcloud group folder, via `db/purge.py`'s `purge_speckle_models`/`purge_project_documents`; never touches the project on Speckle itself), and tail the last 100 non-`/health` requests this process has handled. Proxied at `/admin` by `nginx.conf.template` (same pattern as `/bcf/` and `/bcf-bridge/`) so it's reachable from the dashboard's own origin — linked from the "Admin" button in `BcfKanbanBoard.jsx`'s header, which opens it in a new tab |
| `bcf/request_log.py` | In-memory ring buffer feeding the admin page's request log, fed by a middleware in `bcf_server.py` |
| `bcf/bridge.py` (`/bcf-bridge/*`) | Resolves a Speckle `stream_id` to an ingested `model_id`, linking BCF projects to this app's own models |
| `bcf/bcfxml.py` | `.bcfzip` file import/export (BCF-XML interop format every major BIM tool supports) |

Clash and IDS check results are turned into BCF topics by the frontend calling the same `/bcf/2.1` REST API (`bcfClient.createTopic`) — `clash_check.py` and `ids_check.py` deliberately avoid the `ifcclash`/`ifctester` built-in BCF exporters, which lazily import the third-party `bcf-client` package (top-level module `bcf`) and would collide with this app's own local `bcf/` package.

---

## Frontend components

| Component | Description |
|-----------|-------------|
| `SpeckleViewer` | 3D model viewer powered by `@speckle/viewer` |
| `AdaptiveCharts` | Dynamic ECharts charts driven by normalizer summary data |
| `EChart` | Thin ECharts/core wrapper — one chart instance per container, resize-aware |
| `AdaptiveMetrics` | KPI cards with configurable highlight thresholds |
| `ElementTable` | Paginated, filterable element list synced with 3D viewer selection |
| `ElementPanel` | Detail panel for a single selected element |
| `PivotTableWidget` | Multi-dimensional breakdown (category × storey × material) |
| `QuantityWidget` | 5D quantity takeoff view: volume/area bar charts + coverage stats |
| `ScheduleWidget` | Gantt-style schedule viewer with viewer element sync |
| `DiffBar` | Visual diff: added / removed / changed element counts |
| `TimelinePlayer` | 4D build-up animation driven by date parameters |
| `ValidationWidget` | BIM data quality checks |
| `FilterWidget` / `ActiveFilters` / `filterRules.js` | Rule-based element filtering used across widgets, the viewer, and filter-publish |
| `ClashCheckPanel` / `ClashLogoIcon` | Runs and displays `ifcclash` clash detection results, with click-to-highlight in the 3D viewer. Supports checking a model against itself or against a second, separately selected model for cross-discipline clashes |
| `IdsCheckPanel` / `IdsLogoIcon` | Runs and displays `ifctester` IDS validation results against stored specs |
| `IdsGraphEditor` / `idsGraphNodeTypes` | Visual node-graph editor (`@xyflow/react`) for authoring IDS specifications without hand-writing XML |
| `BcfTopicPanel` / `BcfLogoIcon` | BCF topic list/detail view — create, comment, and resolve issues |
| `BcfKanbanBoard` | Drag-and-drop Kanban board for BCF topic status |
| `BcfStatsWidget` | Topic counts by status/priority |
| `DocumentsPanel` | Nextcloud-backed document workflow: drag-and-drop WIP/Shared/Published/Archived board with an app-enforced reviewed → approved → verified gate |
| `DocumentPreview` (`document-preview/{IfcCanvas,DxfCanvas,DocxCanvas,XlsxCanvas}`) | In-browser document preview — PDF (native iframe), IFC (`web-ifc` WASM + Three.js), DXF (`dxf-viewer`, WebGL/Three.js), DOCX (`docx-preview`, renders to HTML/CSS), XLSX/legacy XLS (SheetJS `xlsx`, `sheet_to_html` per sheet). `.dwg` is converted to DXF server-side (`bim-normalizer/dwg_convert.py` + LibreDWG's `dwg2dxf`) and rendered by the same DXF viewer. No preview path for legacy binary `.doc` |
| `ChatWidget` | AI assistant chat (OpenAI / Anthropic / Mistral / Ollama / LM Studio) |
| `MarkdownWidget` | Editable markdown notes panel |
| `MetricsConfig` | Configuration panel for AdaptiveMetrics thresholds |
| `ViewerToolbar` | Toolbar for 3D viewer actions (section cuts, explode, etc.) |
| `DashboardGrid` | Drag-and-drop, resizable widget grid (`react-grid-layout`), persisted per project via `/dashboard-layout` |
| `WidgetFAB` | Floating action button for adding widgets to the dashboard |
| `ChartBuilder` / `chartSettingsUI` / `StandaloneChartWidget` | User-configurable custom chart widgets |
| `BreadcrumbSelector` | Project / model / version picker |
| `CompareVersionToggle` | Toggle between absolute view and version-diff view |
| `IngestProgress` | Async ingest/export job progress UI |
| `PublishSelectionButton` | Publishes the current viewer selection back to Speckle via filter-publish |
| `VideoWidget` | Embedded video panel for walkthroughs/recordings |
| `IfcLogoIcon` | IFC logo SVG (used as export button) |
| `ErrorBoundary` | React error boundary for graceful per-widget failure isolation |
| `LoginScreen` / `AuthContext` | Dashboard login screen and auth state, gating the ISO 19650 author/reviewer/approver role checks (bypassable only via `DASHBOARD_AUTH_BYPASS`, dev-only) |
| `SpeckleModelsList` | Browsable list of Speckle projects/models for selection |
| `ElementConnectivityPanel` | Multi-hop connectivity graph (`@xyflow/react`) radiating out from a selected element — real relationship data (parent/room/space, IFC relationship entities) shown as solid directional edges, the one geometric-inference edge type (`touches`, zero-tolerance bbox overlap) shown dashed, node opacity fading with hop distance |
| `CombineModelsPicker` / `FederatedBar` / `FederatedClashPanel` | Federated (multi-model) view: combine several models in the viewer and run cross-model clash checks across them |
| `ViewpointMarkupEditor` | Annotate/markup a 3D viewpoint before attaching it to a BCF topic |
| `PanoramaThumbnail` | Thumbnail preview for 360°/panorama images |
| `SchedulePanel` | Native 4D planner: right-docked drawer with Gantt (`ScheduleGanttView`) and build-up playback (`SchedulePlaybackView`) tabs |

---

## Environment variables

### Root `.env` — the single source of truth for the whole stack

`docker-compose.yml` reads this file and passes each value into whichever container(s) need it (frontend build args, bim-normalizer, bcf-server, converge-mcp, or the `postgres`/`nextcloud` services directly) — see the `environment:`/`args:` blocks in [docker-compose.yml](../docker-compose.yml) for the exact wiring. There is no per-service `.env` for any of these containers. Every variable below (required and optional) is documented inline in [`.env.example`](../.env.example) — copy it to `.env` and fill in the values.

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_NAME` | Yes | Postgres connection, shared by bim-normalizer, bcf-server, and Nextcloud's own DB. `PG_HOST`/`PG_PORT` only matter for tools connecting from outside the compose network — containers always talk to `postgres:5432` directly |
| `VITE_SPECKLE_SERVER` | Yes | Speckle server URL (also becomes `SPECKLE_SERVER_URL` for bim-normalizer/bcf-server) |
| `VITE_SPECKLE_TOKEN` | Yes | Personal access token from your Speckle profile (also becomes `SPECKLE_TOKEN`) |
| `VITE_NORMALIZER_URL` | Yes | bim-normalizer URL as seen by the frontend, e.g. `http://localhost:8002` |
| `VITE_EXTRA_SPECKLE_SERVERS` | No | Additional Speckle servers for the frontend's server-switcher dropdown (injected into the frontend at container start — see `src/runtimeConfig.js` — not baked into the image) and bcf-server's admin panel project lookup. Comma-separated, each entry `Name\|URL\|token`. Note: bim-normalizer's own `GET /servers` route reads a differently-named var (`EXTRA_SPECKLE_SERVERS`, no `VITE_` prefix) that docker-compose never sets, so that particular lookup's extra-server list is always empty — the dropdown and bcf-server are unaffected, they read this var directly |
| `PUBLIC_BASE_URL` | No | Publicly reachable base URL ending in `/normalizer`, used for the webhook auto-sync feature. Leave blank to disable |
| `AUTO_SYNC_SCAN_INTERVAL_S` | No | Background re-scan interval in seconds — a dormant-project safety net for missed webhook deliveries. `docker-compose.yml` sets a default of `900` if unset in `.env`; bim-normalizer's own Python-level fallback (3600) only applies outside the documented `docker compose up` flow |
| `DOCUMENT_SYNC_SCAN_INTERVAL_S` | No | Same kind of safety net as above, but for documents that reached Nextcloud some other way than the dashboard's own upload/move/revise/delete calls. Default `3600` |
| `LOG_LEVEL` | No | `debug` / `info` / `warning` — passed to both bim-normalizer and bcf-server. Default `debug` |
| `MCP_API_KEY` | No | Shared secret for remote streamable-HTTP MCP access; empty disables auth (local stdio MCP integration is unaffected — see below) |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated Host-header allow-list (DNS-rebinding protection) for the remote MCP server |
| `MCP_DASHBOARD_EMAIL` / `MCP_DASHBOARD_PASSWORD` | No | Dashboard login the MCP server uses for its Documents/CDE tools when `BCF_ADMIN_EMAIL`/`BCF_ADMIN_PASSWORD` aren't set — passed through to the `converge-mcp` container |
| `BCF_API_KEY` | Yes (for BCF) | Shared Bearer credential between bcf-server and the dashboard's BCF panel. Required — an empty value sends `Authorization: Bearer ` and bcf-server rejects it |
| `BCF_OIDC_SECRET` | No | Signs the `id_token` issued by the OAuth2/OIDC login flow (`bcf/oauth.py`) for clients like BIMcollab ZOOM. Falls back to `BCF_API_KEY`, then a hardcoded dev value, if unset |
| `BCF_ADMIN_EMAIL` / `BCF_ADMIN_PASSWORD` | No | Idempotent startup seed for one `bcf_users` account, for convenience only — the `/admin` panel is always reachable via `BCF_API_KEY` regardless, so leaving these unset can't lock you out |
| `DASHBOARD_SESSION_SECRET` | No | Signs the dashboard's own login session cookie. Falls back to `BCF_OIDC_SECRET`, then `BCF_API_KEY`, if left blank — set explicitly in production |
| `DASHBOARD_AUTH_BYPASS` | No | **DEV/TESTING ONLY.** Skips the dashboard login screen and all ISO 19650 role checks. Leave unset/false always — never set in a deployed environment. Logs a startup warning whenever enabled |
| `NEXTCLOUD_ADMIN_USER` / `NEXTCLOUD_ADMIN_PASSWORD` | Yes | Nextcloud's headless auto-install admin account; also used by bim-normalizer for OCS user/group provisioning |
| `NEXTCLOUD_DB_USER` / `NEXTCLOUD_DB_PASS` | Yes | Nextcloud's own Postgres role (seeded by `postgres-init/01-nextcloud-db.sh` on a fresh volume) |
| `NEXTCLOUD_APP_PASSWORD` | No | WebDAV service account password for bim-normalizer's document uploads/moves/deletes (generate via Nextcloud Settings > Security > "Create new app password"). Falls back to the admin password above if unset |
| `NEXTCLOUD_PORT` | No | Admin/debug port only — never proxied by this dashboard's nginx. Default `8005` |
| `NEXTCLOUD_URL` / `NEXTCLOUD_USER` | No | Only override if bim-normalizer should talk to a Nextcloud instance other than the bundled container, or use a dedicated WebDAV account instead of the admin one |
| `SMTP_HOST` | No | Email side of the notification feed (`notifications/`). Leave unset to run in-app-notifications-only |
| `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_USE_TLS` | No | Standard SMTP relay settings, only read when `SMTP_HOST` is set. `SMTP_PORT` defaults `587`, `SMTP_USE_TLS` defaults `true` |
| `VITE_OPENAI_API_KEY` | No | OpenAI key for the AI chat agent (also becomes `OPENAI_API_KEY` server-side) |
| `VITE_OLLAMA_BASE_URL` / `VITE_OLLAMA_MODEL` | No | Local Ollama endpoint and model name |
| `VITE_LMSTUDIO_BASE_URL` / `VITE_LMSTUDIO_MODEL` | No | LM Studio endpoint and model name |
| `VITE_MISTRAL_API_KEY` | No | Mistral AI key (also becomes `MISTRAL_API_KEY` server-side) |
| `VITE_ANTHROPIC_API_KEY` | No | Anthropic (Claude) key for the AI chat agent (also becomes `ANTHROPIC_API_KEY` server-side) |

### `bim-normalizer/.env` — local Claude Code MCP integration only

Unrelated to the container stack above. `.mcp.json` runs `converge_mcp.py` directly on your machine via stdio, and `python-dotenv` loads this file for whichever variables `.mcp.json`'s own `env` block doesn't already set, plus the BCF/Documents tool credentials below:

| Variable | Required | Description |
|----------|----------|-------------|
| `SPECKLE_SERVER_URL` | No | Speckle server URL — usually already set in `.mcp.json`'s `env` block, which takes precedence |
| `SPECKLE_TOKEN` | Yes | Personal access token; this is the actual reason this file exists |
| `BCF_API_KEY` | No | Only needed to use the BCF/Documents MCP tools locally — shared Bearer credential with bcf-server |
| `MCP_DASHBOARD_EMAIL` / `MCP_DASHBOARD_PASSWORD` | No | Dashboard login for Documents/CDE MCP tools, used if `BCF_ADMIN_EMAIL`/`BCF_ADMIN_PASSWORD` aren't set |

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
│   ├── converge_mcp.py                MCP server (85 tools + 2 resources)
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
│   ├── docker-compose.yml             normalizer + converge-mcp services (standalone dev compose)
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
│   │   ├── schedule.py                4D schedule: IFC work schedule + MS Project XML (MSPDI) + CSV import, task/dependency CRUD
│   │   ├── cpm.py                     Critical Path Method engine (forward/backward pass, float, critical path)
│   │   ├── roles.py                   ISO 19650 author/reviewer/approver role checks
│   │   └── model_status.py            Model/document status tracking
│   └── config/
│       └── settings.py                Environment variable loading
│
├── public/                            Static assets: logos/icons, fonts/, wasm/ (web-ifc, web-ifc-mt)
├── nextcloud-hooks/                   post-installation/ — auto-installs groupfolders on first Nextcloud boot
├── postgres-init/                     01-nextcloud-db.sh — creates Nextcloud's DB on a fresh Postgres volume
├── docker-compose.yml                 Full stack: postgres, bim-normalizer, converge-mcp, bcf-server, dashboard
├── Dockerfile                         Frontend build (Vite, no baked-in secrets) + nginx serve
├── nginx.conf.template                Proxies /normalizer/ and /bcf/ to backend containers
├── config.js.template                 Runtime frontend config template (envsubst'd into window.__CONFIG__)
├── docker-entrypoint-config.sh        Generates config.js from container env vars on every start
├── .mcp.json.example                  Template for local MCP config — copy to .mcp.json (git-ignored)
├── .github/workflows/                 CI: builds + publishes both images to ghcr.io on push/tag
├── package.json
├── vite.config.js
├── tailwind.config.js
└── README.md
```
