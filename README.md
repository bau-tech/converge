<p align="center">
  <img src="public/converge-logo2-transparent.png" alt="Converge logo" width="160">
</p>

# Converge

A React dashboard for BIM analysis, coordination, and validation connected to a self-hosted [Speckle](https://speckle.systems/) server. It ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalises them to an IFC-aligned PostgreSQL schema, and exposes analytics, 3D visualisation, model comparison, BCF issue collaboration, clash detection, IDS (Information Delivery Specification) checking, and an ISO 19650 Common Data Environment for documents — WIP → Shared → Published → Archived with an app-enforced reviewed → approved → verified gate, purpose-of-issue suitability codes, advisory filename-convention checking, org-scoped WIP visibility for multi-contractor projects, shift/ctrl-click multi-select for bulk move or delete, and an in-app/email notification feed covering both uploads and status changes — backed by a dedicated Nextcloud instance, plus an MCP server that lets Claude query and reason over your BIM data.

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
      │                     PostgreSQL schema · IFC export (IFC4X3,
      │                       experimental IFC5/.ifcx)
      │                     Clash check (ifcclash) · IDS check (ifctester)
      │                     Documents (Nextcloud) — reviewed → approved →
      │                       verified gate, suitability codes, org-scoped
      │                       WIP · Notifications (in-app + email) · Auth
      │                       (dashboard login)
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
converge_mcp.py :8003  (converge-mcp server)
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

## System requirements

Idle, the full stack (postgres, nextcloud, bim-normalizer, bcf-server, converge-mcp, dashboard) sits around 500MB RAM. The real constraint is ingest, not steady state: each ingest worker can independently balloon to several GB while processing a large Revit/IFC/Tekla commit (specklepy materializes the whole commit tree — meshes included — before any per-element processing), and bim-normalizer runs `cpu_count - 2` of those workers concurrently (see `bim-normalizer/process_pool.py`). More cores means more workers means more simultaneous multi-GB spikes possible, so RAM and CPU count should scale together, not RAM alone.

| Tier | RAM | Fits |
|---|---|---|
| Minimum | 4GB | Small/medium models, one ingest at a time, light BCF/document use |
| Recommended | 8GB | Typical use — large models, occasional overlapping ingests, headroom for Nextcloud/Postgres growth |
| Heavy | 16GB | Large Revit/IFC models with frequent concurrent ingests, or more CPU cores |

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
                             # bcf-server (:8004), converge-mcp (:8003), dashboard (:8080)
```

`docker compose up -d` builds both application images locally on first run. To skip the build and run the already-published release images from Docker Hub instead:

```bash
cp .env.example .env        # same env vars as above
docker compose -f docker-compose.release.yml up -d
```

See [Deployment (Docker)](#deployment-docker) below for pinning a specific version and using GHCR instead.

### 3. MCP server (local, Claude Code)

Copy `.mcp.json.example` to `.mcp.json` (git-ignored — it holds your local Python path and Speckle server URL) and fill in the `command`/`args`/`env` values for your machine. Claude Code picks it up automatically and runs `converge_mcp.py` directly over stdio. Set `SPECKLE_TOKEN` in `bim-normalizer/.env` — see [MCP server](#mcp-server-converge_mcppy) below and `bim-normalizer/.env.example`.

Every environment variable (required and optional) is documented inline in `.env.example` / `bim-normalizer/.env.example` — see [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md#environment-variables) for the full table if you'd rather read it as reference than as comments.

---

## bim-normalizer

FastAPI backend (`:8002`) that ingests Speckle commits into a normalised PostgreSQL schema and serves ~75 REST routes across ingest/sync, models, elements, analytics, filters, 4D timeline/schedule, IFC export (the mature IFC4X3/STEP export, plus an experimental IFC5/`.ifcx` export — buildingSMART's unratified next-gen JSON-based format), IDS checking, clash detection, an agentic AI chat assistant (30 BIM/CDE tools, OpenAI/Anthropic/Mistral/local-model providers), dashboard auth, Nextcloud-backed documents (ISO 19650 reviewed → approved → verified gate, purpose-of-issue suitability codes, advisory filename-convention checking, and org-scoped WIP visibility so one contractor's work-in-progress stays invisible to another's), a document-workflow notification feed (in-app, plus email if `SMTP_HOST` is configured), dashboard layout/sharing, and debug utilities.

Ingest pipeline: `fetch_commit` (specklepy GraphQL) → `flatten_elements` → `detect_source` (Revit/Tekla/IFC/Navisworks/Blender/Rhino/Grasshopper) → `classify_element` → geometry/parameter extraction → PostgreSQL upsert → best-effort embedding build for semantic search. Re-running `/ingest` for an already-stored commit is an idempotent fast path (`force: true` to re-classify). Speckle webhooks can drive ingestion automatically with nobody's browser open, and the same webhooks — plus a periodic reconciliation scan as a safety net for missed deliveries — mirror deletions back: a project/branch/commit removed on Speckle is purged locally too, including its documents and Nextcloud group folder. Speckle is always the source of truth; converge never deletes anything there on its own.

**Full REST API tables, database schema, and setup:** [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md).

```bash
docker compose up -d --build bim-normalizer   # restart after code changes
docker compose logs -f bim-normalizer
```

---

## bcf-server

A standalone FastAPI process (`bcf_server.py`, separate container) implementing the [BCF-API](https://github.com/buildingSMART/BCF-API) spec for issue tracking, mounted under both `/bcf/2.1` and `/bcf/3.0` (BIMcollab ZOOM only understands 2.1). Shares the same Postgres instance as bim-normalizer. Topics carry a status field rendered as a drag-and-drop Kanban board (`BcfKanbanBoard.jsx`) alongside the standard topic list/detail view (`BcfTopicPanel.jsx`).

A standalone, session-authenticated admin panel (`/admin`, linked from the "Admin" button in `BcfKanbanBoard.jsx`) manages `bcf_users` and their ISO 19650 organization membership (contractual-container separation — which company's WIP a user can see), document-workflow role grants, active OAuth sessions, and ingested models/BCF topics — including permanently purging a project: local models, BCF topics, roles/status, documents, and its Nextcloud group folder, all without touching the source project on Speckle.

**Full module map and the 2.1/3.0 schema differences:** [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md#bcf-server-modules).

---

## MCP server (`converge_mcp.py`)

A [Model Context Protocol](https://modelcontextprotocol.io/) server — 72 tools + 2 resources — that lets Claude read and reason over your Speckle models: an in-memory `ifcopenshell` IFC session, Speckle GraphQL, normalizer REST queries, filters/overrides, QA/diff/semantic-search intelligence tools, clash/schedule checks, Nextcloud documents + BCF, and 5D quantity/BoQ export.

**Full tool catalog:** [`docs/MCP_REFERENCE.md`](docs/MCP_REFERENCE.md).

### Local setup (stdio, Claude Code)

Copy `.mcp.json.example` to `.mcp.json` and fill in your Python path and Speckle server URL. The MCP server reads `SPECKLE_TOKEN` from `bim-normalizer/.env` at startup.

### Remote access (streamable HTTP via Nginx Proxy Manager)

See [`bim-normalizer/npm-mcp-setup.md`](bim-normalizer/npm-mcp-setup.md) for the full NPM configuration guide.

**Summary:**
1. Set a strong `MCP_API_KEY` (and `MCP_ALLOWED_HOSTS`) in `.env`
2. Start the `converge-mcp` Docker service: `docker compose up -d converge-mcp`
3. In NPM, create a proxy host pointing to `<docker-host-IP>:8003`
4. Enable SSL
5. On remote machines, use this `.mcp.json`:

```json
{
  "mcpServers": {
    "converge-mcp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Api-Key": "<your MCP_API_KEY>" }
    }
  }
}
```

---

## Frontend

```bash
npm run dev       # Vite dev server at http://localhost:5173
npm run build     # Production build → dist/
npm run preview   # Serve production build locally
npm run lint      # ESLint
```

Major pieces: the 3D viewer (`SpeckleViewer`) and adaptive charts/metrics/tables synced to it by `speckle_id`; clash (`ClashCheckPanel`) and IDS (`IdsCheckPanel`/`IdsGraphEditor`) checking with viewer highlight and optional BCF topic creation; BCF issue collaboration (`BcfTopicPanel`, `BcfKanbanBoard`); Nextcloud-backed document management with ISO 19650 suitability codes, org-scoped WIP visibility, and shift/ctrl-click multi-select for bulk move (auto-gating review/approve/verify where the user has the role) or bulk delete (`DocumentsPanel`, multi-format `DocumentPreview`); a document-workflow notification bell covering uploads and every status transition (`NotificationBell`); a native 4D planner (`SchedulePanel` — Gantt + build-up playback); federated multi-model views and cross-model clash checks; dashboard login (`LoginScreen`/`AuthContext`); and a drag-and-drop, per-project widget layout (`DashboardGrid`).

**Full component list:** [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md#frontend-components).

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
# Build and start all services (postgres, bim-normalizer, converge-mcp, bcf-server, dashboard)
docker compose up -d --build

# Frontend served at :8080 (nginx proxies /normalizer/ and /bcf/)
# bim-normalizer at :8002, bcf-server at :8004 (internal)
```

### Running from the released images (no build required)

All four images are published on every push to `master` and on every `v*.*.*` tag ([`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)) to two registries:

- Docker Hub: [`docker.io/euch/converge-dashboard`](https://hub.docker.com/r/euch/converge-dashboard), [`docker.io/euch/converge-normalizer`](https://hub.docker.com/r/euch/converge-normalizer), [`docker.io/euch/converge-bcf-server`](https://hub.docker.com/r/euch/converge-bcf-server) (its own slim image — no ifcopenshell/numpy/fastembed/etc., see `bim-normalizer/Dockerfile.bcf-server`), and [`docker.io/euch/converge-mcp`](https://hub.docker.com/r/euch/converge-mcp) (also its own slim image — just mcp[cli]/requests/ifcopenshell/ifc5d/uvicorn, see `bim-normalizer/Dockerfile.converge-mcp`)
- GHCR: `ghcr.io/bau-tech/converge-dashboard`, `ghcr.io/bau-tech/converge-normalizer`, `ghcr.io/bau-tech/converge-bcf-server`, and `ghcr.io/bau-tech/converge-mcp`

Each push produces four tags per image: `latest` (default branch only), a semver `X.Y.Z` + `X.Y` pair (tag pushes only, e.g. `0.1.0` / `0.1`), and the short commit SHA. The dashboard image bakes in no secrets — all `VITE_*` config is injected at container start from environment variables (`config.js.template`, `src/runtimeConfig.js`), so the same published image works for any deployment without a rebuild.

[`docker-compose.release.yml`](docker-compose.release.yml) is a ready-to-use copy of `docker-compose.yml` with `bim-normalizer`/`converge-mcp`/`bcf-server`/`converge` pulling from Docker Hub instead of building:

```bash
cp .env.example .env
docker compose -f docker-compose.release.yml up -d

# pin a specific release instead of latest
CONVERGE_VERSION=0.1.0 docker compose -f docker-compose.release.yml up -d
```

To pull from GHCR instead, edit `docker-compose.release.yml` and swap the `docker.io/euch/converge-*` image names for `ghcr.io/bau-tech/converge-*` (same tags apply). Both GHCR packages are public, so no `docker login` is needed either way.

Postgres and Nextcloud still come from their upstream public images either way (`postgres:16-alpine`, `nextcloud:apache`) — only the two converge-authored services change.

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
