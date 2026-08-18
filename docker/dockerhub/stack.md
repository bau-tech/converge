<p align="center">
  <img src="https://raw.githubusercontent.com/bau-tech/converge/master/public/converge-logo2-transparent.png" alt="Converge logo" width="120">
</p>

# Converge

A BIM coordination, analytics, and collaboration platform built on [Speckle](https://speckle.systems/). Converge ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalizes them to an IFC-aligned PostgreSQL schema, and gives teams a single place to visualize, validate, and collaborate on a project's BIM data — 3D viewing, clash detection, IDS checking, BCF issue collaboration, model comparison, 4D planning, 5D takeoff, an ISO 19650 Common Data Environment for documents, and an AI copilot (dashboard chat, or the standalone MCP server for Claude Code/Claude.ai).

This repository isn't an image of its own — it's the overview for the whole **Converge stack**, four separately published images plus PostgreSQL and Nextcloud, wired together by one Compose file.

## The four images

| Image | Role |
|---|---|
| [`euch/converge-dashboard`](https://hub.docker.com/r/euch/converge-dashboard) | React + Vite frontend (Nginx) — viewer, charts, BCF/Documents UI, AI Assistant |
| [`euch/converge-normalizer`](https://hub.docker.com/r/euch/converge-normalizer) | Core API — Speckle ingestion, IFC export, clash/IDS checks, documents, notifications |
| [`euch/converge-bcf-server`](https://hub.docker.com/r/euch/converge-bcf-server) | BCF 2.1/3.0 issue-tracking API, BIMcollab OAuth shim |
| [`euch/converge-mcp`](https://hub.docker.com/r/euch/converge-mcp) | MCP server — 85 tools exposing BIM data to Claude |

Each image repo's own page (linked above) covers its specific config variables, ports, and health checks in more detail.

## Non-Converge dependencies

- **PostgreSQL 16** (`postgres:16-alpine`) — shared schema for `bim_normalizer` and `bcf-server`
- **Nextcloud** (`nextcloud:apache`) — headless document storage/versioning backend for the Documents (ISO 19650 CDE) feature, plus a `nextcloud-cron` sidecar for preview pre-generation and webhook-driven sync

Neither is a Converge-built image — both are pulled straight from their official upstream images.

## Architecture

```
Browser ── converge-dashboard (Nginx, :80)
             │
             ├─ REST ─► bim-normalizer (:8002) ─► PostgreSQL
             │             │                        ▲
             │             ├─► Nextcloud (documents) │
             │             └─► Speckle server         │
             │                                         │
             └─ REST ─► bcf-server (:8004) ────────────┘

converge-mcp (:8003) ─► bim-normalizer, bcf-server, Speckle server directly
```

## Quick start

```bash
git clone https://github.com/bau-tech/converge.git
cd converge
cp .env.example .env   # fill in Speckle server/token, Nextcloud admin creds, etc.
docker compose -f docker-compose.release.yml up -d
```

This brings up all six containers (dashboard, normalizer, bcf-server, mcp, postgres, nextcloud + nextcloud-cron) wired together. The dashboard is then available at `http://localhost:8080`. See [`.env.example`](https://github.com/bau-tech/converge/blob/master/.env.example) for the full variable list and [`docker-compose.release.yml`](https://github.com/bau-tech/converge/blob/master/docker-compose.release.yml) for the service definitions.

## Tags

Each of the four images is tagged consistently:

- `latest` — latest build of `master`
- `X.Y.Z` / `X.Y` — semver releases (git tags `vX.Y.Z`)
- short commit SHA — every push to `master`

Pin `CONVERGE_VERSION` in `.env` to select the same tag across all four.

## Source

[github.com/bau-tech/converge](https://github.com/bau-tech/converge) — also published to [GHCR](https://github.com/bau-tech/converge/pkgs/container/converge-dashboard).
