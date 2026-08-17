<p align="center">
  <img src="https://raw.githubusercontent.com/bau-tech/converge/master/public/converge-logo2-transparent.png" alt="Converge logo" width="120">
</p>

# Converge Normalizer

The core API of **Converge** — a BIM coordination, analytics, and collaboration platform built on [Speckle](https://speckle.systems/). This FastAPI (Python 3.11) service is the biggest of the four images: it owns the schema, the ingestion pipeline, and most of the domain logic the dashboard renders.

## What's inside

- **Ingestion & normalization** — pulls Speckle streams/commits/blobs via `specklepy` + GraphQL, flattens per-source-app object models (Revit, Tekla, IFC, Navisworks, Blender, Rhino, Grasshopper — both the Speckle connectors v3 instance/definition split and the flat v2 model) into a unified, IFC-aligned PostgreSQL schema
- **IFC export** — IFC4X3, plus an experimental IFC5/.ifcx exporter
- **Clash detection** — `ifcclash`, with cached resolved-IFC-byte lookups and batched-retry resilience for large federated scenes
- **IDS compliance checking** — `ifctester` against uploaded Information Delivery Specifications
- **Documents (ISO 19650 CDE)** — backed by a dedicated headless Nextcloud instance over WebDAV/OCS; WIP → Shared → Published → Archived workflow, app-enforced reviewed → approved → verified gate, suitability codes, org-scoped WIP visibility, content search (PDF text extraction via `poppler-utils`), thumbnail generation (including `.dwg` → `.dxf` via a statically-linked `dwg2dxf` built from LibreDWG)
- **Notifications** — in-app + email, for both uploads and status changes
- **4D/5D analytics** — schedule status, quantity/cost data feeding the dashboard's takeoff and Gantt views
- **AI Assistant backend** — chat + semantic search endpoints (`fastembed`) over BIM elements and documents
- **Auth** — dashboard session login (`bcrypt`/`pyjwt`)
- **BCF Coordination Reports** — calls out to `bcf-server` to assemble combined report exports

It's the largest of the four images (dependencies include `fastapi`, `psycopg2`, `specklepy`, `ifcopenshell`, `ifc5d`, `ifctester`, `ifcclash`, `numpy`, `fastembed`, `ezdxf`, `cairosvg`, `python-docx`, `openpyxl`, `reportlab`) — `bcf-server` and `converge-mcp` are deliberately split into their own slim images rather than sharing this one, since neither needs most of this dependency set.

## Configuration

Full variable list in [`.env.example`](https://github.com/bau-tech/converge/blob/master/.env.example) in the source repo. The main ones:

| Variable | Purpose |
|---|---|
| `SPECKLE_SERVER_URL` / `SPECKLE_TOKEN` | Speckle server to ingest from |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_NAME` | PostgreSQL connection |
| `NEXTCLOUD_URL` / `NEXTCLOUD_ADMIN_USER` / `NEXTCLOUD_ADMIN_PASSWORD` | Nextcloud CDE backend for Documents |
| `OPENAI_API_KEY` / `MISTRAL_API_KEY` | Optional hosted LLM backends for the AI Assistant |
| `BCF_SERVER_URL` | Internal URL to reach `bcf-server` for coordination reports |
| `AUTO_SYNC_SCAN_INTERVAL_S` | How often to poll Speckle for new commits |
| `DASHBOARD_SESSION_SECRET` | Session signing secret for dashboard auth |

## Ports & health

- `8002` — HTTP API
- Healthcheck: `GET /health`

## Requirements

Needs PostgreSQL and Nextcloud reachable, and a Speckle server (self-hosted or app.speckle.systems) with a valid token. See **Quick start** below for the one-command way to bring up the whole stack together.

## The Converge stack

| Image | Role |
|---|---|
| [`euch/converge-dashboard`](https://hub.docker.com/r/euch/converge-dashboard) | React frontend (Nginx) |
| **`euch/converge-normalizer`** (this image) | Core API — ingestion, IFC export, clash/IDS checks, documents |
| [`euch/converge-bcf-server`](https://hub.docker.com/r/euch/converge-bcf-server) | BCF 2.1/3.0 issue-tracking API |
| [`euch/converge-mcp`](https://hub.docker.com/r/euch/converge-mcp) | MCP server — lets Claude query your BIM data |

## Quick start

```bash
git clone https://github.com/bau-tech/converge.git
cd converge
cp .env.example .env   # fill in Speckle server/token, Nextcloud admin creds, etc.
docker compose -f docker-compose.release.yml up -d
```

The API is then available at `http://localhost:8002`.

## Tags

- `latest` — latest build of `master`
- `X.Y.Z` / `X.Y` — semver releases (git tags `vX.Y.Z`)
- short commit SHA — every push to `master`

## Source

[github.com/bau-tech/converge](https://github.com/bau-tech/converge) · also published to [GHCR](https://github.com/bau-tech/converge/pkgs/container/converge-normalizer)
