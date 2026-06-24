# Speckle Dashboard

A React dashboard for BIM analysis, coordination, and validation connected to a self-hosted [Speckle](https://speckle.systems/) server. It ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalises them to an IFC-aligned PostgreSQL schema, and exposes analytics, 3D visualisation, model comparison, BCF issue collaboration, clash detection, IDS (Information Delivery Specification) checking, and an MCP server that lets Claude query and reason over your BIM data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  React + Vite   ──► @speckle/viewer (3D)               │
│                 ──► ECharts (charts)                    │
│                 ──► @xyflow/react (IDS graph editor)    │
└───────┬──────────────────────┬───────────────────────────┘
        │ REST                 │ BCF-API (REST)
┌───────▼──────────────┐ ┌─────▼───────────────┐
│  bim-normalizer :8002│ │  bcf-server :8004    │  FastAPI + Python 3.11
│  PostgreSQL schema    │ │  BCF 2.1 / 3.0 API   │  Docker containers,
│  IFC export (IFC4X3)  │ │  topics/comments/    │  shared Postgres
│  Clash check (ifcclash)│ │  viewpoints, OAuth   │
│  IDS check (ifctester) │ │  shim for BIMcollab  │
└───────┬──────────────┘ └──────────┬───────────┘
        │ specklepy + GraphQL       │ shared bim_models/elements
┌───────▼───────────────────────────▼───────────┐
│  Speckle server          PostgreSQL            │
│  streams / commits / blobs   :5432             │
└─────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Claude Code / Claude.ai                                 │
│  MCP client                                              │
└──────────────┬───────────────────────────────────────────┘
               │ stdio (local)  or  HTTPS/streamable-HTTP (remote)
  ┌────────────▼────────────┐
  │  speckle_mcp.py  :8003  │   FastMCP — 40+ tools
  │  (speckle-ifc server)   │   ifcopenshell in-memory IFC session
  └────────────┬────────────┘
               │ REST
          bim-normalizer :8002
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
- A running [Speckle server](https://speckle.systems/) (self-hosted or speckle.xyz)

---

## Quick start

### 1. Frontend

```bash
npm install
cp .env.example .env        # fill in VITE_* variables
npm run dev                 # http://localhost:5173
```

### 2. bim-normalizer

```bash
cd bim-normalizer
cp .env.example .env        # fill in SPECKLE_TOKEN, PG_*, MCP_API_KEY, BCF_API_KEY
docker compose up -d        # starts normalizer on :8002
```

### 3. bcf-server

Runs from the same `bim-normalizer/` build context as a separate process (`python bcf_server.py`, port `8004`), sharing the Postgres instance. See [docker-compose.yml](docker-compose.yml) for the full three-service wiring (normalizer + bcf-server + dashboard).

### 4. MCP server (local, Claude Code)

The `.mcp.json` in the project root is picked up automatically by Claude Code. Set `SPECKLE_TOKEN` in `bim-normalizer/.env` — it is loaded by the MCP server at startup via `python-dotenv`.

---

## Environment variables

### Frontend (`/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SPECKLE_SERVER` | Yes | Speckle server URL, e.g. `https://speckle.example.com` |
| `VITE_SPECKLE_TOKEN` | Yes | Personal access token from your Speckle profile |
| `VITE_NORMALIZER_URL` | Yes | bim-normalizer URL, e.g. `http://localhost:8002` |
| `PUBLIC_BASE_URL` | No | Publicly reachable base URL ending in `/normalizer`, used by nginx for the webhook auto-sync feature. Leave blank to disable auto-sync |
| `AUTO_SYNC_SCAN_INTERVAL_S` | No | How often (seconds) to re-scan watched servers for new projects without a webhook yet (default `900`) |
| `MCP_API_KEY` | No | Shared secret for remote streamable-HTTP MCP access; empty disables auth (local stdio only) |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated Host-header allow-list (DNS-rebinding protection) for the remote MCP server |
| `BCF_API_KEY` | Yes (for BCF) | Shared Bearer credential between bcf-server and the dashboard's BCF panel. Required — an empty value sends `Authorization: Bearer ` and bcf-server rejects it |
| `VITE_OPENAI_API_KEY` | No | OpenAI key for the AI chat agent |
| `VITE_OLLAMA_BASE_URL` | No | Local Ollama endpoint (e.g. `http://localhost:11434`) |
| `VITE_OLLAMA_MODEL` | No | Ollama model name (e.g. `qwen2.5:1.5b`) |
| `VITE_LMSTUDIO_BASE_URL` | No | LM Studio endpoint |
| `VITE_LMSTUDIO_MODEL` | No | LM Studio model name |
| `VITE_MISTRAL_API_KEY` | No | Mistral AI key |

### bim-normalizer (`/bim-normalizer/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SPECKLE_SERVER_URL` | Yes | Speckle server URL |
| `SPECKLE_TOKEN` | Yes | Personal access token |
| `PUBLIC_BASE_URL` | No | Publicly reachable base URL (through your reverse proxy) for the webhook auto-sync feature. Leave blank to disable |
| `AUTO_SYNC_SCAN_INTERVAL_S` | No | Re-scan interval in seconds for new projects (default `900`) |
| `PG_HOST` | Yes | PostgreSQL host — service refuses to start if unset |
| `PG_PORT` | No | PostgreSQL port (default `5432`) |
| `PG_USER` | Yes | PostgreSQL user — service refuses to start if unset |
| `PG_PASS` | Yes | PostgreSQL password — service refuses to start if unset |
| `PG_NAME` | Yes | PostgreSQL database name — service refuses to start if unset |
| `PORT` | No | Normalizer listen port (default `8002`) |
| `MCP_API_KEY` | No | API key for remote MCP streamable-HTTP/SSE access; empty = no auth |
| `MCP_ALLOWED_HOSTS` | No | Comma-separated Host-header allow-list for the remote MCP server |
| `LOG_LEVEL` | No | `debug` / `info` / `warning` (default `info`) |
| `OPENAI_API_KEY` | No | OpenAI key used by the server-side chat agent |
| `MISTRAL_API_KEY` | No | Mistral AI key used by the server-side chat agent |
| `EXTRA_SPECKLE_SERVERS` | No | Additional Speckle servers exposed by `GET /servers`. Comma-separated, each entry `Name\|URL\|token` |

### bcf-server (shares the bim-normalizer `.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_NAME` | Yes | Same Postgres instance as bim-normalizer |
| `PORT` | No | BCF server listen port (default `8004`) |
| `BCF_API_KEY` | Yes | Shared Bearer credential checked on every BCF request |
| `BCF_OIDC_SECRET` | No | Signs the fake `id_token` issued by the OAuth2/OIDC shim (`bcf/oauth.py`), needed for clients like BIMcollab ZOOM that require a real-looking login flow |

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
```

Re-running `/ingest` for a commit that is already stored returns immediately (idempotent fast path). Use `force: true` to re-classify from scratch. Speckle webhooks (`speckle/webhooks.py`) can drive this automatically — the backend registers webhooks on watched servers and re-ingests new commits with nobody's browser open (`PUBLIC_BASE_URL` + `AUTO_SYNC_SCAN_INTERVAL_S`).

### Database schema

```
bim_models          stream_id, commit_id, branch_name, source, author, ingested_at
  └── bim_elements  application_id, speckle_id, ifc_class, category, name, storey, hash
        ├── bim_geometry      bbox, centroid, volume_m3, area_m2, mesh (JSONB)
        ├── bim_parameters    pset, key, value, datatype
        └── bim_relationships element_id → related_id, relation_type

bcf_*                projects, topics, comments, viewpoints (BCF-API 2.1/3.0 schema, bcf/db_schema.py)
```

### REST API reference

#### Ingest & sync

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Start async ingest job. Body: `{stream_id, commit_id, force?}` |
| `GET` | `/ingest/status/{job_id}` | Poll job status |
| `GET` | `/auto-sync/servers` | List servers watched for webhook-driven auto-sync |
| `POST` | `/auto-sync/servers` | Add/update a watched server |
| `POST` | `/webhooks/speckle/{webhook_row_id}` | Webhook receiver — Speckle calls this on new commits |

#### Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models` | List all ingested models |
| `GET` | `/models/{id}` | Model metadata + element count |
| `DELETE` | `/models/{id}` | Delete model and all associated data |
| `GET` | `/models/trend/{stream_id}` | Element/category counts across all versions of a stream |

#### Elements

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| `GET` | `/models/{id}/elements` | `category`, `ifc_class`, `storey`, `name`, `speckle_id`, `limit`, `offset` | Filtered element list |
| `GET` | `/models/{id}/elements/flat` | same + `limit`, `offset` | Elements enriched with geometry + material/profile/grade |
| `GET` | `/models/{id}/elements/by-parameter` | parameter key/value filters | Elements matching arbitrary parameter values |
| `GET` | `/models/{id}/elements/nearby` | `speckle_id`, `radius_m` | Elements within a radius of a given element's centroid |
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
| `POST` | `/models/{id}/schedule/import` | Import a schedule file (`multipart/form-data`). Accepts `.ifc` (IfcWorkSchedule) or `.xml` (Primavera P6 XML) |

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
| `POST` | `/models/{id}/clash-check` | Run BVH mesh-level clash detection via `ifcclash` (same engine as BlenderBIM/Bonsai). Returns `{job_id}` |
| `GET` | `/models/{id}/clash-check/{job_id}/status` | Poll clash job; results map clashing pairs to element `speckle_id`s for viewer highlight and optional BCF topic creation |

#### AI Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/servers` | List configured AI provider endpoints |
| `POST` | `/chat` | Agentic chat with BIM context. Body: `{model_id, message, history, ai_provider, ...}`. Returns `{text, elementIds, toolsUsed}` |
| `POST` | `/chat/stream` | Same as `/chat`, streamed (SSE) |

#### Dashboard layout & sharing

| Method | Path | Description |
|--------|------|-------------|
| `GET` / `PUT` | `/dashboard-layout/{project_id}` | Persist the drag-and-drop widget layout per project |
| `POST` / `GET` | `/share` | Create / list shareable dashboard snapshots |
| `GET` / `DELETE` | `/share/{share_id}` | Fetch or revoke a share link |

#### Utility & Debug

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{"status": "ok"}` |
| `GET` | `/debug/inspect/{stream_id}/{commit_id}` | Geometry coverage analysis without storing |
| `POST` | `/debug/classify-inspect` | Show classification signals for first N elements |

### Docker

```bash
# Build and start
docker compose up -d

# View logs
docker compose logs -f bim-normalizer

# Restart after code changes
docker compose up -d --build bim-normalizer
```

The `speckle-network` Docker network must exist before starting:

```bash
docker network create speckle-network
```

---

## bcf-server

A standalone FastAPI process (`bcf_server.py`, same `bim-normalizer/` build context, separate container — mirrors how `speckle-mcp` is wired) implementing the [BCF-API](https://github.com/buildingSMART/BCF-API) spec for issue tracking, mounted under both `/bcf/2.1` and `/bcf/3.0` since BIMcollab ZOOM only understands 2.1. Shares the same Postgres instance as bim-normalizer (`bcf_*` tables, initialised by `bcf/db_schema.py`).

| Module | Responsibility |
|--------|-----------------|
| `bcf/projects.py`, `bcf/topics.py`, `bcf/comments.py`, `bcf/viewpoints.py` | Core BCF-API resource routers |
| `bcf/auth.py`, `bcf/auth_discovery.py` | Bearer-token auth + the `/auth` discovery endpoint |
| `bcf/oauth.py` | Fake OAuth2/OIDC shim — some clients (confirmed: BIMcollab ZOOM) refuse the spec's Basic-Auth fallback and require a real-looking Authorization Code + PKCE flow with an `openid` scope. There are no real user accounts behind it; every request auto-approves a fixed identity |
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
Work on an in-memory `ifcopenshell` model loaded with `ifc_load` or `speckle_load`.

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
| `speckle_load(model_id)` | Export as IFC and load into memory session |
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

#### 5D / Quantity tools (IFC session)
Work on the model loaded with `ifc_load` or `speckle_load`.

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
      "url": "https://mcp.speckle.example.com/mcp",
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
| `ClashCheckPanel` / `ClashLogoIcon` | Runs and displays `ifcclash` clash detection results, with click-to-highlight in the 3D viewer |
| `IdsCheckPanel` / `IdsLogoIcon` | Runs and displays `ifctester` IDS validation results against stored specs |
| `IdsGraphEditor` / `idsGraphNodeTypes` | Visual node-graph editor (`@xyflow/react`) for authoring IDS specifications without hand-writing XML |
| `BcfTopicPanel` / `BcfLogoIcon` | BCF topic list/detail view — create, comment, and resolve issues |
| `BcfKanbanBoard` | Drag-and-drop Kanban board for BCF topic status |
| `BcfStatsWidget` | Topic counts by status/priority |
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

```
speckle-dashboard/
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
│   │   └── ...
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
│       └── useDrawerWidth.js          Hook for resizable side-drawer width
│
├── bim-normalizer/
│   ├── main.py                        FastAPI app, all REST endpoints
│   ├── speckle_mcp.py                 MCP server (40+ tools)
│   ├── bcf_server.py                  BCF-API 2.1/3.0 server (separate process/container)
│   ├── clash_check.py                 Clash detection via ifcclash
│   ├── ids_check.py                   IDS validation via ifctester
│   ├── Dockerfile                     Python 3.11 image (shared by normalizer/MCP/BCF)
│   ├── docker-compose.yml             normalizer + speckle-mcp services (standalone dev compose)
│   ├── requirements.txt
│   ├── .env                           secrets (not committed)
│   ├── npm-mcp-setup.md               NPM reverse proxy setup guide
│   ├── bcf/
│   │   ├── projects.py, topics.py, comments.py, viewpoints.py   Core BCF-API routers
│   │   ├── auth.py, auth_discovery.py                            Bearer auth + discovery
│   │   ├── oauth.py                                              Fake OIDC shim for BIMcollab ZOOM
│   │   ├── bridge.py                                             Speckle stream_id ↔ model_id resolution
│   │   ├── bcfxml.py                                             .bcfzip import/export
│   │   ├── db.py, db_schema.py                                   BCF Postgres schema + queries
│   │   ├── schemas.py                                            Pydantic models
│   │   └── versions.py                                           BCF version constants
│   ├── chat/
│   │   └── agent.py                   Agentic chat backend (LLM + DB tools)
│   ├── pipeline/
│   │   └── normalize.py               Ingest pipeline orchestrator
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
│   │   ├── timeline.py                4D parameter discovery
│   │   └── schedule.py                4D schedule: IFC work schedule + P6 XML import
│   └── config/
│       └── settings.py                Environment variable loading
│
├── docker-compose.yml                 Full stack: postgres, bim-normalizer, speckle-mcp, bcf-server, dashboard
├── Dockerfile                         Frontend build (Vite) + nginx serve
├── nginx.conf.template                Proxies /normalizer/ and /bcf/ to backend containers
├── .mcp.json                          MCP server registration (Claude Code)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── README.md
```

---

## Related

- [Speckle](https://speckle.systems/) — open source BIM data platform
- [ifcopenshell](https://ifcopenshell.org/) — IFC processing library used for export, clash detection (`ifcclash`), and MCP IFC tools
- [ifctester](https://pypi.org/project/ifctester/) — IDS (Information Delivery Specification) validation engine
- [BCF-API](https://github.com/buildingSMART/BCF-API) / [BCF-XML](https://github.com/buildingSMART/BCF-XML) — buildingSMART issue collaboration specs implemented by bcf-server
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP specification
