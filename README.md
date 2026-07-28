<p align="center">
  <img src="public/converge-logo-transparent.png" alt="Converge logo" width="160">
</p>

# Converge

A React dashboard for BIM analysis, coordination, and validation connected to a self-hosted [Speckle](https://speckle.systems/) server. It ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalises them to an IFC-aligned PostgreSQL schema, and exposes analytics, 3D visualisation, model comparison, BCF issue collaboration, clash detection, IDS (Information Delivery Specification) checking, document management backed by a dedicated Nextcloud instance (WIP → Shared → Published → Archived, with an app-enforced reviewed → approved → verified gate), and an MCP server that lets Claude query and reason over your BIM data.

---

## Architecture

```
Browser — React + Vite
  • @speckle/viewer          3D model viewer
  • ECharts                  charts
  • @xyflow/react            IDS graph editor
  • native 4D planner        WBS/Gantt authoring + CPM + build-up playback
      │
      ├─ REST ──────────► bim-normalizer :8002   (FastAPI, Python 3.11)
      │                     PostgreSQL schema · IFC export (IFC4X3)
      │                     Clash check (ifcclash) · IDS check (ifctester)
      │                     Documents (Nextcloud) — reviewed → approved →
      │                       verified gate · Auth (dashboard login)
      │                       │
      │                       ├─ specklepy + GraphQL ─► Speckle server
      │                       │                          (streams/commits/blobs)
      │                       └─ WebDAV/OCS ────────────► Nextcloud :8005
      │                                                    (headless; groupfolders
      │                                                    per project — WIP/Shared/
      │                                                    Published/Archived; never
      │                                                    exposed to end users)
      │
      └─ BCF-API (REST) ──► bcf-server :8004   (FastAPI, Python 3.11)
                               BCF 2.1 / 3.0 API · topics/comments/viewpoints
                               OAuth shim for BIMcollab
                               │
                               └─ shared bim_models/elements ─► PostgreSQL :5432
                                                                  (same instance
                                                                  as bim-normalizer)

Claude Code / Claude.ai — MCP client
  │ stdio (local)  or  HTTPS/streamable-HTTP (remote)
  ▼
speckle_mcp.py :8003  (speckle-ifc server)
  FastMCP — 72 tools + 2 resources · ifcopenshell in-memory IFC session
  │
  └─ REST ─► bim-normalizer :8002
```

---

## Source app support

| App | Detection method | Classification strategy |
|-----|-----------------|------------------------|
| Revit | `sourceApplication` / speckle_type prefix | Revit category map → IFC class |
| Tekla Structures | `sourceApplication` / speckle_type prefix | Tekla type map → IFC class |
| IFC (open) | `sourceApplication` contains "ifc"/"open" | speckle_type `IfcXxx` → IFC class |
| Navisworks | `sourceApplication` | `LcRevitData_Element` property group |
| Blender | `sourceApplication` / `collectionType` | User properties bag heuristic |
| Rhino | `sourceApplication` | Layer name → IFC heuristic |
| Grasshopper | `sourceApplication` | Same as Rhino |
| Generic | fallback | speckle_type heuristic |

Both the Speckle connectors **v3** instance/definition split (geometry on `obj.definition`, not the object directly) and the flat v2 object model are handled automatically during element flattening.

---

## Prerequisites

- **Node.js 20+** — frontend dev server
- **Docker + Docker Compose** — bim-normalizer, bcf-server, and MCP server
- **PostgreSQL 14+** — can be an external instance; see `.env` for connection vars
- **Speckle account** with a personal access token
- A running [Speckle server](https://speckle.systems/) (self-hosted or app.speckle.systems)

---

## Quick start

### 1. Frontend dev server (optional — for `npm run dev` against an already-running backend)

```bash
npm install
cp .env.example .env        # fill in VITE_* variables
npm run dev                 # http://localhost:5173
```

### 2. Full stack (bim-normalizer + bcf-server + postgres + nextcloud + dashboard)

Everything is orchestrated by the single [docker-compose.yml](docker-compose.yml) at the repo root — there is no separate compose file per service.

```bash
cp .env.example .env        # fill in SPECKLE_TOKEN, PG_*, MCP_API_KEY, BCF_API_KEY, etc.
docker compose up -d        # starts postgres, nextcloud, bim-normalizer (:8002),
                             # bcf-server (:8004), speckle-mcp (:8003), dashboard (:8080)
```

### 3. MCP server (local, Claude Code)

The `.mcp.json` in the project root is picked up automatically by Claude Code and runs `speckle_mcp.py` directly on your machine over stdio (separate from the `speckle-mcp` Docker service above, which serves the same tools over streamable-HTTP for remote access). Set `SPECKLE_TOKEN` in `bim-normalizer/.env` — it's loaded by this local process at startup via `python-dotenv`. See `bim-normalizer/.env.example` for the variables this file needs (the containerized services above get their config entirely from the root `.env`, not this file).

---

## Environment variables

### Root `.env` — the single source of truth for the whole stack

`docker-compose.yml` reads this file and passes each value into whichever container(s) need it (frontend build args, bim-normalizer, bcf-server, speckle-mcp, or the `postgres`/`nextcloud` services directly) — see the `environment:`/`args:` blocks in [docker-compose.yml](docker-compose.yml) for the exact wiring. There is no per-service `.env` for any of these containers.

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_NAME` | Yes | Postgres connection, shared by bim-normalizer, bcf-server, and Nextcloud's own DB. `PG_HOST`/`PG_PORT` only matter for tools connecting from outside the compose network — containers always talk to `postgres:5432` directly |
| `VITE_SPECKLE_SERVER` | Yes | Speckle server URL, e.g. `https://speckle.example.com` (also becomes `SPECKLE_SERVER_URL` for bim-normalizer/bcf-server) |
| `VITE_SPECKLE_TOKEN` | Yes | Personal access token from your Speckle profile (also becomes `SPECKLE_TOKEN`) |
| `VITE_NORMALIZER_URL` | Yes | bim-normalizer URL as seen by the frontend, e.g. `http://localhost:8002` |
| `VITE_EXTRA_SPECKLE_SERVERS` | No | Additional Speckle servers for the frontend's server-switcher dropdown (baked in at build time) and bcf-server's admin panel project lookup. Comma-separated, each entry `Name\|URL\|token`. Note: bim-normalizer's own `GET /servers` route reads a differently-named var (`EXTRA_SPECKLE_SERVERS`, no `VITE_` prefix) that docker-compose never sets, so that particular lookup's extra-server list is always empty — the dropdown and bcf-server are unaffected, they read this var directly |
| `PUBLIC_BASE_URL` | No | Publicly reachable base URL ending in `/normalizer`, used for the webhook auto-sync feature. Leave blank to disable |
| `AUTO_SYNC_SCAN_INTERVAL_S` | No | Background re-scan interval in seconds — a dormant-project safety net for missed webhook deliveries. `docker-compose.yml` sets a default of `900` if unset in `.env`; bim-normalizer's own Python-level fallback (3600) only applies outside the documented `docker compose up` flow |
| `DOCUMENT_SYNC_SCAN_INTERVAL_S` | No | Same kind of safety net as above, but for documents that reached Nextcloud some other way than the dashboard's own upload/move/revise/delete calls. Default `3600` |
| `LOG_LEVEL` | No | `debug` / `info` / `warning` — passed to both bim-normalizer and bcf-server. Default `debug` |
| `MCP_API_KEY` | No | Shared secret for remote streamable-HTTP MCP access; empty disables auth (local stdio MCP integration is unaffected — see below) |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated Host-header allow-list (DNS-rebinding protection) for the remote MCP server |
| `MCP_DASHBOARD_EMAIL` / `MCP_DASHBOARD_PASSWORD` | No | Dashboard login the MCP server uses for its Documents/CDE tools when `BCF_ADMIN_EMAIL`/`BCF_ADMIN_PASSWORD` aren't set — passed through to the `speckle-mcp` container |
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
| `VITE_OPENAI_API_KEY` | No | OpenAI key for the AI chat agent (also becomes `OPENAI_API_KEY` server-side) |
| `VITE_OLLAMA_BASE_URL` / `VITE_OLLAMA_MODEL` | No | Local Ollama endpoint and model name |
| `VITE_LMSTUDIO_BASE_URL` / `VITE_LMSTUDIO_MODEL` | No | LM Studio endpoint and model name |
| `VITE_MISTRAL_API_KEY` | No | Mistral AI key (also becomes `MISTRAL_API_KEY` server-side) |

### `bim-normalizer/.env` — local Claude Code MCP integration only

Unrelated to the container stack above. `.mcp.json` runs `speckle_mcp.py` directly on your machine via stdio, and `python-dotenv` loads this file for whichever variables `.mcp.json`'s own `env` block doesn't already set, plus the BCF/Documents tool credentials below:

| Variable | Required | Description |
|----------|----------|-------------|
| `SPECKLE_SERVER_URL` | No | Speckle server URL — usually already set in `.mcp.json`'s `env` block, which takes precedence |
| `SPECKLE_TOKEN` | Yes | Personal access token; this is the actual reason this file exists |
| `BCF_API_KEY` | No | Only needed to use the BCF/Documents MCP tools locally — shared Bearer credential with bcf-server |
| `MCP_DASHBOARD_EMAIL` / `MCP_DASHBOARD_PASSWORD` | No | Dashboard login for Documents/CDE MCP tools, used if `BCF_ADMIN_EMAIL`/`BCF_ADMIN_PASSWORD` aren't set |

---

## bim-normalizer

### Ingest pipeline

```
POST /ingest  {stream_id, commit_id}
       │
       ▼
  fetch_commit()           specklepy GraphQL → Base object tree
       │
  flatten_elements()       recursive traversal, skips geometry fragments
       │
  detect_source()          Revit / Tekla / IFC / Navisworks / Blender / Rhino / Grasshopper
       │
  classify_element()       speckle_type + properties → {ifc_class, category}
       │
  extract geometry         mesh → bbox, centroid, volume_m3 (divergence theorem), area_m2
       │
  extract parameters       all property sets → bim_parameters rows
       │
  PostgreSQL upsert        bim_models + bim_elements + bim_geometry + bim_parameters
       │
  build embeddings         best-effort, batched — local CPU model (fastembed) embeds each new
                           element's description into bim_element_embeddings for semantic search.
                           Never fails the ingest; skipped elements are just missing from search.
```

Re-running `/ingest` for a commit that is already stored returns immediately (idempotent fast path). Use `force: true` to re-classify from scratch. Speckle webhooks (`speckle/webhooks.py`) can drive this automatically — the backend registers webhooks on watched servers and re-ingests new commits with nobody's browser open (`PUBLIC_BASE_URL` + `AUTO_SYNC_SCAN_INTERVAL_S`).

### Database schema

```
bim_models          stream_id, commit_id, branch_name, source, author, ingested_at
  └── bim_elements  application_id, speckle_id, ifc_class, category, name, storey, hash
        ├── bim_geometry            bbox, centroid, volume_m3, area_m2, mesh (JSONB)
        ├── bim_parameters          pset, key, value, datatype
        ├── bim_relationships       element_id → related_id, relation_type
        └── bim_element_embeddings  embed_text, embedding (FLOAT[]) — semantic search, search/embeddings.py

bim_model_status     stream_id-scoped model/document status tracking (db/model_status.py)

bim_tasks            4D schedule tasks — name, dates, IFC/MSPDI-imported or manually created (db/schedule.py)
  ├── bim_task_elements      task_id ↔ element_id links, for viewer sync
  └── bim_task_dependencies  task_id → predecessor_id (schedule sequencing)

bcf_*                projects, topics, comments, viewpoints (BCF-API 2.1/3.0 schema, bcf/db_schema.py)

bim_jobs             job_id, job_type, status, payload, result, error (async job state — ingest/export/
                     filter-publish/IDS-check/clash-check/document-backfill — DB-backed so a backend
                     restart doesn't strand a polling client with an unrecoverable 404, db/jobs.py)

bim_documents         stream_id-scoped (survives re-ingestion, unlike model_id), Nextcloud-backed
                     document metadata — status (WIP/Shared/Published/Archived), doc_type
                     (document/drawing), a reviewed/approved/verified triad (each with its own
                     *_by/*_at attribution), revision, linked_bcf_topic, linked_element
                     (db/documents.py, nextcloud/)
  └── bim_document_events  append-only audit trail — created/moved/reviewed/approved/verified/revised/deleted/linked

bim_document_roles   stream_id-scoped author/reviewer/approver RBAC backing the /my-roles endpoint

bim_dashboard_layouts        per-project drag-and-drop widget layout (GET/PUT /dashboard-layout)
bim_classification_overrides manual property overrides (POST /models/{id}/overrides)
bim_ids_specs                stored IDS specifications (POST /models/{id}/ids-specs)
auto_sync_servers            watched Speckle servers for webhook-driven auto-sync (GET/POST /auto-sync/servers)
stream_webhooks               registered Speckle webhook rows (speckle/webhooks.py)
```

### REST API reference

bim-normalizer exposes ~70 routes across ingest/sync, models, elements, analytics, filters, 4D timeline/schedule, IFC export, IDS checking, clash detection, AI chat, dashboard auth, Nextcloud-backed documents (the ISO 19650 reviewed → approved → verified gate), dashboard layout/sharing, and debug utilities.

**Full method/path/description tables: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md#rest-api-reference-bim-normalizer).**

### Docker

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f bim-normalizer

# Restart after code changes
docker compose up -d --build bim-normalizer
```

`docker-compose.yml` declares its own bridge network (`speckle-net`) and Compose creates it automatically on `up` — no manual `docker network create` step needed.

---

## bcf-server

A standalone FastAPI process (`bcf_server.py`, same `bim-normalizer/` build context, separate container — mirrors how `speckle-mcp` is wired) implementing the [BCF-API](https://github.com/buildingSMART/BCF-API) spec for issue tracking, mounted under both `/bcf/2.1` and `/bcf/3.0` since BIMcollab ZOOM only understands 2.1. Shares the same Postgres instance as bim-normalizer (`bcf_*` tables, initialised by `bcf/db_schema.py`).

`bcf/projects.py` and `bcf/topics.py` share their router instances across both version mounts (`bcf_server.py`'s prefix loop), but the 2.1 and 3.0 schemas aren't identical — confirmed against the official `release_2_1`/`release_3_0` branches of the BCF-API spec, two fields differ and are branched at request time via `bcf.versions.is_bcf_v3(request)`: the assignable-users list in `GET .../extensions` is `user_id_type` in 2.1 but `users` in 3.0, and 3.0's `topic_GET`/`topic_POST` responses additionally require a `server_assigned_id` string (sourced from the otherwise-unused `"index"` column, backfilled for pre-existing rows by `BACKFILL_INDEX_SQL`). Getting either of these wrong under `/bcf/3.0/` is what made 3.0-based BIMcollab Manager plugins show "no assignable team members" when creating an issue, even though the same data is fine over `/bcf/2.1/`.

| Module | Responsibility |
|--------|-----------------|
| `bcf/projects.py`, `bcf/topics.py`, `bcf/comments.py`, `bcf/viewpoints.py` | Core BCF-API resource routers |
| `bcf/auth.py`, `bcf/auth_discovery.py` | Bearer-token auth + the `/auth` discovery endpoint |
| `bcf/foundation.py` | OpenCDE Foundation API (`/foundation/{version}/auth`) — BCF 3.0 is an OpenCDE API and some clients look here before falling back to `/bcf/{version}/auth` |
| `bcf/users.py` (`/bcf-bridge/users`) | `bcf_users` CRUD, backing both the admin panel and OAuth login |
| `bcf/password.py` | bcrypt password hashing/verification for `bcf_users` |
| `bcf/oauth.py` | Real OAuth2/OIDC login against `bcf_users` — some clients (confirmed: BIMcollab ZOOM) refuse the spec's Basic-Auth fallback and require a real-looking Authorization Code + PKCE flow with an `openid` scope. Issued tokens/sessions are in-memory only (lost on every restart) |
| `bcf/admin.py` (`/admin`) | Standalone session-cookie-authenticated admin page (plain HTML/JS, no build step) — manage `bcf_users`, view/revoke active OAuth sessions, browse ingested models with their BCF topics (incl. snapshot thumbnails) and per-project `bcf_extensions` value lists, purge models/streams, and tail the last 100 non-`/health` requests this process has handled. Proxied at `/admin` by `nginx.conf.template` (same pattern as `/bcf/` and `/bcf-bridge/`) so it's reachable from the dashboard's own origin — linked from the "Admin" button in `BcfKanbanBoard.jsx`'s header, which opens it in a new tab |
| `bcf/request_log.py` | In-memory ring buffer feeding the admin page's request log, fed by a middleware in `bcf_server.py` |
| `bcf/bridge.py` (`/bcf-bridge/*`) | Resolves a Speckle `stream_id` to an ingested `model_id`, linking BCF projects to this app's own models |
| `bcf/bcfxml.py` | `.bcfzip` file import/export (BCF-XML interop format every major BIM tool supports) |

Clash and IDS check results are turned into BCF topics by the frontend calling the same `/bcf/2.1` REST API (`bcfClient.createTopic`) — `clash_check.py` and `ids_check.py` deliberately avoid the `ifcclash`/`ifctester` built-in BCF exporters, which lazily import the third-party `bcf-client` package (top-level module `bcf`) and would collide with this app's own local `bcf/` package.

### BCF Kanban board

Topics carry a status field rendered as a drag-and-drop Kanban board (`BcfKanbanBoard.jsx`) alongside the standard topic list/detail view (`BcfTopicPanel.jsx`).

---

## MCP server (`speckle_mcp.py`)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that lets Claude read and reason over your Speckle models. Registered in `.mcp.json` — Claude Code picks it up automatically when this folder is open.

### Tool groups

#### IFC session tools
Work on an in-memory `ifcopenshell` model loaded with `ifc_load`. The code's own docstrings and
error messages also point to a `speckle_load(model_id)` bridge tool (export a normalizer-ingested
model as IFC and load it into this session) — but that function (`speckle_mcp.py:740`) has no
`@mcp.tool()` decorator, so it is **not actually registered/callable** (confirmed absent from the
live tool listing). Likely a bug: currently there's no way to load a normalizer-ingested model into
an IFC session via MCP, only a local `.ifc` file via `ifc_load`.

| Tool | Description |
|------|-------------|
| `ifc_new` | Create empty IFC model |
| `ifc_load(path)` | Load a local `.ifc` file |
| `ifc_reset` | Unload current model |
| `ifc_save(path)` | Save to disk |
| `ifc_summary` | Schema, project name, entity counts |
| `ifc_tree` | Spatial hierarchy (Project → Site → Building → Storey) |
| `ifc_info(element_id)` | All attributes + property sets for one element |
| `ifc_select(ifc_class)` | List all elements of a class (e.g. `IfcWall`) |
| `ifc_relations(element_id)` | All relationships an element participates in |
| `ifc_materials` | All material definitions |
| `ifc_write_pset(element_ids, pset_name, properties)` | Write/update a property set on one or more elements |

#### Speckle server tools (GraphQL)
| Tool | Description |
|------|-------------|
| `speckle_list_projects` | List projects on the Speckle server |
| `speckle_list_models(project_id)` | List models (branches) in a project |
| `speckle_list_versions(project_id, model_name)` | List commits |

#### Normalizer tools (REST)
| Tool | Description |
|------|-------------|
| `speckle_list_ingested` | All models in PostgreSQL |
| `speckle_get_summary(model_id)` | Category / storey / material breakdown |
| `speckle_query_elements(model_id, ...)` | Filtered element query |
| `speckle_query_by_parameter(model_id, ...)` | Filter elements by arbitrary parameter key/value |
| `speckle_find_nearby(model_id, speckle_id, radius_m)` | Elements within a radius of a given element |
| `speckle_parameter_keys(model_id)` | Distinct parameter keys present on a model |
| `speckle_get_materials(model_id)` | Material definitions used in a model |
| `speckle_get_profiles(model_id)` | Structural profile definitions used in a model |
| `speckle_ingest(stream_id, commit_id)` | Ingest a Speckle commit (waits for completion) |
| `speckle_export_csv(model_id, ...)` | Export elements/parameters as CSV |

#### Filters & overrides tools
| Tool | Description |
|------|-------------|
| `speckle_list_overrides(model_id)` | List manual property overrides |
| `speckle_set_overrides(model_id, overrides_json)` | Create/update overrides |
| `speckle_apply_overrides(model_id)` | Apply pending overrides to stored elements |
| `speckle_filter_publish(model_id, ...)` | Publish a filtered element subset back to Speckle |
| `classification_reload` | Hot-reload classification rules |

#### Intelligence tools
| Tool | Description |
|------|-------------|
| `speckle_get_object(stream_id, object_id)` | Raw Speckle object properties (streaming) |
| `speckle_element_detail(element_id)` | Full element: geometry quantities + all parameter sets |
| `speckle_diff_models(model_id_a, model_id_b)` | Added / removed / changed + per-category deltas |
| `speckle_qa_check(model_id)` | 0–1 quality score with per-issue breakdown and sample IDs |
| `speckle_qa_elements(model_id, issue, limit?)` | Elements behind a specific QA issue |
| `speckle_compare_categories(model_ids)` | Side-by-side category table for up to 6 models |
| `speckle_find_element(query, model_id?)` | Name search across all ingested models |
| `speckle_quantities(model_id, group_by?)` | Fast quantity takeoff from the DB — no IFC load required. `group_by`: `ifc_class` (default) \| `category` \| `storey` |
| `speckle_cost_estimate(model_id, rates_json, group_by?)` | Apply unit rates to quantities for a rough cost estimate |
| `speckle_trend_analysis(model_id, limit?)` | Element/category counts across versions of a stream |

#### Semantic search & agentic workflow tools
Semantic search runs against embeddings computed automatically at ingest time (local CPU model,
`search/embeddings.py` — no external API, no pgvector). The workflow tools are deterministic,
hardcoded chains of the primitive tools above (no LLM reasoning happens inside the server) that
return one consolidated report instead of requiring several separate calls.

| Tool | Description |
|------|-------------|
| `speckle_semantic_search(model_id, query, limit?)` | Find elements by meaning rather than exact text — e.g. `"fire rated door"` matches even if those exact words never appear in the element's name/parameters |
| `speckle_investigate_element(model_id, query, radius_m?)` | Resolves an element by name/description, then reports identity + parameters, nearby elements, and QA flags in one call — chains semantic search → `speckle_element_detail` → `speckle_find_nearby` → `speckle_qa_check` |
| `speckle_full_qa_report(model_id)` | Full data-quality report: score, model context, real example elements per issue category (not just the 3 samples `speckle_qa_check` shows), and a fix list prioritized by weight × affected-count |
| `speckle_investigate_clashes(model_id, rules_json, compare_model_id?)` | Runs clash detection and reports which categories/elements are actually colliding and where (grouped example pairs + distances), not just a count |
| `speckle_schedule_status_report(model_id)` | Schedule health in one call: task counts by status, critical-path tasks, overdue tasks, and tasks with no elements linked |

See [`bim-normalizer/testing-semantic-search.md`](bim-normalizer/testing-semantic-search.md) for how to verify these end-to-end after rebuilding.

#### Clash & schedule tools
Primitive building blocks the two workflow tools above are built on — use these directly when
you just need the raw result rather than a synthesized report.

| Tool | Description |
|------|-------------|
| `speckle_clash_check(model_id, rules_json, compare_model_id?)` | Run BVH mesh-level clash detection (ifcclash) and wait for the result (blocking, up to 5 min). `rules_json`: JSON array of `{name?, selector_a, selector_b?, mode?, tolerance?, clearance?}` |
| `speckle_schedule(model_id)` | Full 4D task schedule tree — name, WBS code, status, dates, critical-path flag, linked element count |

#### Documents & BCF tools
Mirror the Documents and BCF REST APIs above, for use from Claude without going through the
dashboard UI. Document tools need a real dashboard login (`MCP_DASHBOARD_EMAIL`/`_PASSWORD`, or
the `BCF_ADMIN_EMAIL`/`_PASSWORD` fallback) since they're role-gated; BCF topic tools work with
just `BCF_API_KEY`.

| Tool | Description |
|------|-------------|
| `speckle_list_documents(stream_id, status?)` | List documents for a project |
| `speckle_document_detail(stream_id, doc_id)` | Metadata + audit event history |
| `speckle_upload_document(stream_id, ...)` | Upload a document — lands in `01_WIP` |
| `speckle_move_document(stream_id, doc_id, status)` | Move between WIP/Shared/Published/Archived (app-enforced gate) |
| `speckle_set_document_review(stream_id, doc_id)` / `speckle_set_document_approval(...)` / `speckle_set_document_verification(...)` | Set the reviewed / approved / verified stage |
| `speckle_link_document_topic(stream_id, doc_id, topic_id)` / `speckle_link_document_element(...)` | Link a document to a BCF topic or model element |
| `speckle_delete_document(stream_id, doc_id)` | Soft-delete (audit trail survives) |
| `speckle_list_topics(stream_id)` | List BCF topics for a project |
| `speckle_topic_detail(stream_id, topic_id)` | Full topic detail |
| `speckle_create_topic(stream_id, ...)` / `speckle_update_topic(...)` | Create/update a BCF topic |
| `speckle_list_comments(stream_id, topic_id)` / `speckle_add_comment(...)` | List/add topic comments |
| `speckle_list_viewpoints(stream_id, topic_id)` | List topic viewpoints |
| `speckle_list_ids_specs(model_id)` / `speckle_upload_ids_spec(...)` / `speckle_delete_ids_spec(...)` | List/store/delete IDS specifications |
| `speckle_ids_check(model_id, spec_id)` | Run an IDS spec against the model via `ifctester` |

#### Cache maintenance
Read-heavy tools (`speckle_get_summary`, `speckle_qa_check`, `speckle_qa_elements`,
`speckle_semantic_search`, `speckle_parameter_keys`, `speckle_get_materials`,
`speckle_get_profiles`, and the workflow tools' internal calls to those same endpoints) share a
45-second in-process cache in `speckle_mcp.py` — smooths a burst of related calls in one exchange
without ever risking staleness beyond well under a minute. Every write/mutating call bypasses it
entirely.

| Tool | Description |
|------|-------------|
| `speckle_cache_clear()` | Force-clear the cache — use right after a re-ingest if you need the very next read to be guaranteed-fresh |

#### Resources (browsable context, not tool calls)
| URI | Description |
|-----|-------------|
| `speckle://models` | All ingested models — id, stream, source, element count |
| `speckle://models/{model_id}/summary` | One model's category/IFC-class/storey/material summary |

See [`bim-normalizer/testing-clash-schedule-resources.md`](bim-normalizer/testing-clash-schedule-resources.md)
for how to verify the clash/schedule tools, cache, and resources end-to-end. Unlike the semantic
search round, this one only touches `speckle_mcp.py` — no `bim-normalizer` rebuild needed.

#### 5D / Quantity tools (IFC session)
Work on the model loaded with `ifc_load` (see the `speckle_load` bug note above — there is
currently no MCP path to load a normalizer-ingested model here).

| Tool | Description |
|------|-------------|
| `ifc5d_quantities(group_by?)` | Aggregate quantity takeoff from IfcElementQuantity sets. `group_by`: `ifc_class` (default) \| `storey` \| `material` |
| `ifc5d_cost_schedule()` | List IfcCostSchedule hierarchies with cost items and referenced quantities |
| `ifc5d_boq_export(output_path?)` | Export a Bill of Quantities as CSV; returns the path or the CSV content |

### Local setup (stdio, Claude Code)

`.mcp.json` is already configured. The MCP server reads `SPECKLE_TOKEN` from `bim-normalizer/.env` at startup. No further setup needed.

### Remote access (streamable HTTP via Nginx Proxy Manager)

See [`bim-normalizer/npm-mcp-setup.md`](bim-normalizer/npm-mcp-setup.md) for the full NPM configuration guide.

**Summary:**
1. Set a strong `MCP_API_KEY` (and `MCP_ALLOWED_HOSTS`) in `.env`
2. Start the `speckle-mcp` Docker service: `docker compose up -d speckle-mcp`
3. In NPM, create a proxy host pointing to `<docker-host-IP>:8003`
4. Enable SSL
5. On remote machines, use this `.mcp.json`:

```json
{
  "mcpServers": {
    "speckle-ifc": {
      "type": "http",
      "url": "https://mcp-speckle.example.com/mcp",
      "headers": { "X-Api-Key": "<your MCP_API_KEY>" }
    }
  }
}
```

---

## Frontend

### Development

```bash
npm run dev       # Vite dev server at http://localhost:5173
npm run build     # Production build → dist/
npm run preview   # Serve production build locally
npm run lint      # ESLint
```

### Key components

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
| `ChatWidget` | AI assistant chat (OpenAI / Ollama / LM Studio / Mistral) |
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
| `CombineModelsPicker` / `FederatedBar` / `FederatedClashPanel` | Federated (multi-model) view: combine several models in the viewer and run cross-model clash checks across them |
| `ViewpointMarkupEditor` | Annotate/markup a 3D viewpoint before attaching it to a BCF topic |
| `PanoramaThumbnail` | Thumbnail preview for 360°/panorama images |
| `SchedulePanel` | Native 4D planner: right-docked drawer with Gantt (`ScheduleGanttView`) and build-up playback (`SchedulePlaybackView`) tabs |

### Dashboard data flow

```
User selects project + model version
          │
          ▼
App.jsx  loadModelDataFromNormalizer()
          │
          ├── GET /models/{id}/summary    → charts + metrics
          ├── GET /models/{id}/elements/flat → element table
          └── @speckle/viewer             → 3D scene

User clicks element in table ──► viewer highlights object (speckle_id)
User clicks object in 3D    ──► table scrolls to matching row

Clash/IDS check run ──► failures/clashes mapped to speckle_id ──► viewer highlight
                                                              └─► optional BCF topic (bcfClient.createTopic)
```

### Deployment (Docker)

```bash
# Build and start all services (postgres, bim-normalizer, speckle-mcp, bcf-server, dashboard)
docker compose up -d --build

# Frontend served at :8080 (nginx proxies /normalizer/ and /bcf/)
# bim-normalizer at :8002, bcf-server at :8004 (internal)
```

---

## Project structure

Top-level layout — `src/` (React frontend), `bim-normalizer/` (FastAPI backend: ingest, REST API, MCP server, bcf-server, Nextcloud client), plus `public/`, `nextcloud-hooks/`, `postgres-init/`, and the root Docker/Vite config files.

**Full annotated file tree: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md#project-structure).**

---

## Related

- [Speckle](https://speckle.systems/) — open source BIM data platform
- [ifcopenshell](https://ifcopenshell.org/) — IFC processing library used for export, clash detection (`ifcclash`), and MCP IFC tools
- [ifctester](https://pypi.org/project/ifctester/) — IDS (Information Delivery Specification) validation engine
- [BCF-API](https://github.com/buildingSMART/BCF-API) / [BCF-XML](https://github.com/buildingSMART/BCF-XML) — buildingSMART issue collaboration specs implemented by bcf-server
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP specification
