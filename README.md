# Speckle Dashboard

A React dashboard for BIM analysis connected to a self-hosted [Speckle](https://speckle.systems/) server. It ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalises them to an IFC-aligned PostgreSQL schema, and exposes analytics, 3D visualisation, model comparison, and an AI assistant — plus an MCP server that lets Claude query and reason over your BIM data.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  React + Vite   ──► @speckle/viewer (3D)               │
│                 ──► ECharts (charts)                    │
└───────────────────────┬─────────────────────────────────┘
                        │ REST
          ┌─────────────▼──────────────┐
          │  bim-normalizer  :8002     │   FastAPI + Python 3.11
          │  PostgreSQL schema         │   Docker container
          │  IFC export (IFC4X3)       │
          └─────────────┬──────────────┘
                        │ specklepy + GraphQL
          ┌─────────────▼──────────────┐
          │  Speckle server            │   https://speckle.example.com
          │  streams / commits / blobs │
          └────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Claude Code / Claude.ai                                 │
│  MCP client                                              │
└──────────────┬───────────────────────────────────────────┘
               │ stdio (local)  or  HTTPS/SSE (remote via NPM)
  ┌────────────▼────────────┐
  │  speckle_mcp.py  :8003  │   FastMCP — 28 tools
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

---

## Prerequisites

- **Node.js 20+** — frontend dev server
- **Docker + Docker Compose** — bim-normalizer and MCP server
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
cp .env.example .env        # fill in SPECKLE_TOKEN, PG_*, MCP_API_KEY
docker compose up -d        # starts normalizer on :8002
```

### 3. MCP server (local, Claude Code)

The `.mcp.json` in the project root is picked up automatically by Claude Code. Set `SPECKLE_TOKEN` in `bim-normalizer/.env` — it is loaded by the MCP server at startup via `python-dotenv`.

---

## Environment variables

### Frontend (`/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SPECKLE_SERVER` | Yes | Speckle server URL, e.g. `https://speckle.example.com` |
| `VITE_SPECKLE_TOKEN` | Yes | Personal access token from your Speckle profile |
| `VITE_NORMALIZER_URL` | Yes | bim-normalizer URL, e.g. `http://localhost:8002` |
| `VITE_OPENAI_API_KEY` | No | OpenAI key for the AI Assistant widget |
| `VITE_OLLAMA_BASE_URL` | No | Local Ollama endpoint (e.g. `http://localhost:11434`) |
| `VITE_OLLAMA_MODEL` | No | Ollama model name (e.g. `llama3.2`) |
| `VITE_LMSTUDIO_BASE_URL` | No | LM Studio endpoint |
| `VITE_LMSTUDIO_MODEL` | No | LM Studio model name |
| `VITE_MISTRAL_API_KEY` | No | Mistral AI key |

### bim-normalizer (`/bim-normalizer/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SPECKLE_SERVER_URL` | Yes | Speckle server URL |
| `SPECKLE_TOKEN` | Yes | Personal access token |
| `PG_HOST` | Yes | PostgreSQL host — service refuses to start if unset |
| `PG_PORT` | No | PostgreSQL port (default `5432`) |
| `PG_USER` | Yes | PostgreSQL user — service refuses to start if unset |
| `PG_PASS` | Yes | PostgreSQL password — service refuses to start if unset |
| `PG_NAME` | Yes | PostgreSQL database name — service refuses to start if unset |
| `PORT` | No | Normalizer listen port (default `8002`) |
| `MCP_API_KEY` | No | API key for remote MCP SSE access; empty = no auth |
| `LOG_LEVEL` | No | `debug` / `info` / `warning` (default `info`) |
| `OPENAI_API_KEY` | No | OpenAI key used by the server-side chat agent |
| `MISTRAL_API_KEY` | No | Mistral AI key used by the server-side chat agent |
| `EXTRA_SPECKLE_SERVERS` | No | Additional Speckle servers exposed by `GET /servers`. Comma-separated, each entry `Name\|URL\|token` |

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

Re-running `/ingest` for a commit that is already stored returns immediately (idempotent fast path). Use `force: true` to re-classify from scratch.

### Database schema

```
bim_models          stream_id, commit_id, branch_name, source, author, ingested_at
  └── bim_elements  application_id, speckle_id, ifc_class, category, name, storey, hash
        ├── bim_geometry    bbox, centroid, volume_m3, area_m2, mesh (JSONB)
        ├── bim_parameters  pset, key, value, datatype
        └── bim_relationships  element_id → related_id, relation_type
```

### REST API reference

#### Ingest

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ingest` | Start async ingest job. Body: `{stream_id, commit_id, force?}` |
| `GET` | `/ingest/status/{job_id}` | Poll job status |

#### Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models` | List all ingested models |
| `GET` | `/models/{id}` | Model metadata + element count |
| `DELETE` | `/models/{id}` | Delete model and all associated data |

#### Elements

| Method | Path | Query params | Description |
|--------|------|-------------|-------------|
| `GET` | `/models/{id}/elements` | `category`, `ifc_class`, `storey`, `name`, `speckle_id`, `limit`, `offset` | Filtered element list |
| `GET` | `/models/{id}/elements/flat` | same + `limit`, `offset` | Elements enriched with geometry + material/profile/grade |
| `GET` | `/elements/{element_id}` | — | Single element with all parameters and geometry |

#### Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/summary` | Count + volume + area by category, ifc_class, storey; material/profile/grade distributions |
| `GET` | `/models/{id}/qa` | Quality report: missing names, storeys, geometry, materials, duplicates; 0–1 score |
| `GET` | `/diff/{model_a}/{model_b}` | Added / removed / changed elements + per-category deltas |

#### 4D Timeline

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/timeline/params` | Discover date/sequence parameters for animation |
| `GET` | `/models/{id}/timeline/data` | Elements grouped by parameter value |

#### IFC Export

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/models/{id}/export/ifc` | Start async IFC4X3 export. Returns `{job_id}` |
| `GET` | `/models/{id}/export/ifc/{job_id}/status` | Poll export job |
| `GET` | `/models/{id}/export/ifc/{job_id}/download` | Download `.ifc` file |

If the source is IFC, the original blob uploaded to the Speckle server is served directly — no re-export.

#### Quantities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/quantities` | Quantity takeoff from DB — element count + volume (m³) + area (m²). Query param: `group_by` = `ifc_class` (default) \| `category` \| `storey` |

#### Schedule (4D)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models/{id}/schedule` | Return full task tree with linked element `speckle_id`s for viewer sync |
| `POST` | `/models/{id}/schedule/import` | Import a schedule file (`multipart/form-data`). Accepts `.ifc` (IfcWorkSchedule) or `.xml` (Primavera P6 XML) |

#### AI Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/servers` | List configured AI provider endpoints |
| `POST` | `/chat` | Agentic chat with BIM context. Body: `{model_id, message, history, ai_provider, ...}`. Returns `{text, elementIds, toolsUsed}` |

#### Utility

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{"status": "ok"}` |

#### Debug

| Method | Path | Description |
|--------|------|-------------|
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
| `speckle_ingest(stream_id, commit_id)` | Ingest a Speckle commit (waits for completion) |
| `speckle_load(model_id)` | Export as IFC and load into memory session |

#### Intelligence tools
| Tool | Description |
|------|-------------|
| `speckle_get_object(stream_id, object_id)` | Raw Speckle object properties (streaming) |
| `speckle_element_detail(element_id)` | Full element: geometry quantities + all parameter sets |
| `speckle_diff_models(model_id_a, model_id_b)` | Added / removed / changed + per-category deltas |
| `speckle_qa_check(model_id)` | 0–1 quality score with per-issue breakdown and sample IDs |
| `speckle_compare_categories(model_ids)` | Side-by-side category table for up to 6 models |
| `speckle_find_element(query, model_id?)` | Name search across all ingested models |
| `speckle_quantities(model_id, group_by?)` | Fast quantity takeoff from the DB — no IFC load required. `group_by`: `ifc_class` (default) \| `category` \| `storey` |

#### 5D / Quantity tools (IFC session)
Work on the model loaded with `ifc_load` or `speckle_load`.

| Tool | Description |
|------|-------------|
| `ifc5d_quantities(group_by?)` | Aggregate quantity takeoff from IfcElementQuantity sets. `group_by`: `ifc_class` (default) \| `storey` \| `material` |
| `ifc5d_cost_schedule()` | List IfcCostSchedule hierarchies with cost items and referenced quantities |
| `ifc5d_boq_export(output_path?)` | Export a Bill of Quantities as CSV; returns the path or the CSV content |

### Local setup (stdio, Claude Code)

`.mcp.json` is already configured. The MCP server reads `SPECKLE_TOKEN` from `bim-normalizer/.env` at startup. No further setup needed.

### Remote access (SSE via Nginx Proxy Manager)

See [`bim-normalizer/npm-mcp-setup.md`](bim-normalizer/npm-mcp-setup.md) for the full NPM configuration guide.

**Summary:**
1. Set a strong `MCP_API_KEY` in `.env`
2. Start the `speckle-mcp` Docker service: `docker compose up -d speckle-mcp`
3. In NPM, create a proxy host pointing to `<docker-host-IP>:8003`
4. Enable SSL, add SSE proxy directives in the Advanced tab
5. On remote machines, use this `.mcp.json`:

```json
{
  "mcpServers": {
    "speckle-ifc": {
      "type": "sse",
      "url": "https://mcp.speckle.example.com/sse",
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
| `DimensionalMetrics` | Expandable property-dimension cards with inline bar charts |
| `ElementTable` | Paginated, filterable element list synced with 3D viewer selection |
| `PivotTableWidget` | Multi-dimensional breakdown (category × storey × material) |
| `QuantityWidget` | 5D quantity takeoff view: volume/area bar charts + coverage stats |
| `ScheduleWidget` | Gantt-style schedule viewer with viewer element sync |
| `DiffBar` | Visual diff: added / removed / changed element counts |
| `TimelinePlayer` | 4D build-up animation driven by date parameters, with a "Sync charts" toggle to narrow dashboard charts/tables to elements built up to the current step |
| `ValidationWidget` | BIM data quality checks |
| `ChatWidget` | AI assistant chat (OpenAI / Ollama / LM Studio / Mistral) |
| `MarkdownWidget` | Editable markdown notes panel |
| `MetricsConfig` | Configuration panel for AdaptiveMetrics thresholds |
| `ViewerToolbar` | Toolbar for 3D viewer actions (section cuts, explode, etc.) |
| `ResizableLayout` | Drag-and-drop resizable panel layout |
| `SortableItem` | Generic drag-and-drop sortable wrapper |
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
```

### Deployment (Docker)

```bash
# Build and start all services
docker compose up -d --build

# Frontend served at :8080
# bim-normalizer at :8002 (internal)
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
│   │   ├── DimensionalMetrics.jsx     Expandable property-dimension cards
│   │   ├── ElementTable.jsx
│   │   ├── ElementPanel.jsx
│   │   ├── PivotTableWidget.jsx
│   │   ├── QuantityWidget.jsx         5D quantity takeoff visualisation
│   │   ├── ScheduleWidget.jsx         Gantt-style schedule viewer
│   │   ├── ValidationWidget.jsx
│   │   ├── ChatWidget.jsx
│   │   ├── MarkdownWidget.jsx         Editable markdown notes panel
│   │   ├── MetricsConfig.jsx          Threshold config for AdaptiveMetrics
│   │   ├── DiffBar.jsx
│   │   ├── TimelinePlayer.jsx
│   │   ├── ResizableLayout.jsx
│   │   ├── SortableItem.jsx           Drag-and-drop sortable wrapper
│   │   ├── ViewerToolbar.jsx          3D viewer action toolbar
│   │   ├── DashboardGrid.jsx
│   │   ├── ChartBuilder.jsx
│   │   ├── ActiveFilters.jsx
│   │   ├── AIAssistant.jsx
│   │   ├── ErrorBoundary.jsx          Per-widget React error boundary
│   │   ├── IfcLogoIcon.jsx            IFC logo SVG (used as export button)
│   │   └── ...
│   ├── lib/
│   │   ├── echarts.js                 Central ECharts registration (tree-shaken chart types)
│   │   └── echartsTheme.js            Shared dark/light theme builders for chart options
│   └── utils/
│       ├── speckleContextBuilder.js   Builds AI context from model data
│       ├── propertyScanner.js         Scans object trees for property keys
│       ├── rawDataProcessor.js        Transforms raw Speckle objects
│       └── speckleTraversal.js        Object tree traversal helpers
│
├── bim-normalizer/
│   ├── main.py                        FastAPI app, all REST endpoints
│   ├── speckle_mcp.py                 MCP server (28 tools)
│   ├── Dockerfile                     Python 3.11 image
│   ├── docker-compose.yml             normalizer + speckle-mcp services
│   ├── requirements.txt
│   ├── .env                           secrets (not committed)
│   ├── npm-mcp-setup.md               NPM reverse proxy setup guide
│   ├── chat/
│   │   └── agent.py                   Agentic chat backend (LLM + DB tools)
│   ├── pipeline/
│   │   └── normalize.py               Ingest pipeline orchestrator
│   ├── speckle/
│   │   ├── fetch.py                   Speckle commit fetch + element flattening
│   │   └── client.py                  SpecklePy client wrapper
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
├── .mcp.json                          MCP server registration (Claude Code)
├── package.json
├── vite.config.js
├── tailwind.config.js
└── README.md
```

---

## Speckle connectors

The normalizer is tested with **Speckle connectors v3**. Both the v3 instance/definition split (where geometry lives on `obj.definition`, not on the object directly) and the flat v2 object model are handled automatically during element flattening.

---

## Related

- [Speckle](https://speckle.systems/) — open source BIM data platform
- [ifcopenshell](https://ifcopenshell.org/) — IFC processing library used for export and MCP IFC tools
- [Model Context Protocol](https://modelcontextprotocol.io/) — MCP specification
