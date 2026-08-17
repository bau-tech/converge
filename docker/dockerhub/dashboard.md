<p align="center">
  <img src="https://raw.githubusercontent.com/bau-tech/converge/master/public/converge-logo2-transparent.png" alt="Converge logo" width="120">
</p>

# Converge Dashboard

The frontend of **Converge** — a BIM coordination, analytics, and collaboration platform built on [Speckle](https://speckle.systems/). Converge ingests models from Revit, Tekla, IFC, Navisworks, Blender, Rhino, and Grasshopper, normalizes them to an IFC-aligned schema, and gives teams a single place to visualize, validate, and collaborate on a project's BIM data.

This image is a React + Vite single-page app, built once and served by Nginx. It talks to two other Converge services over REST (`bim-normalizer` and `bcf-server`, proxied by the same Nginx config) and holds no state of its own — it's stateless and horizontally scalable.

## What's inside

- **3D viewer** (`@speckle/viewer`) — federated multi-model viewing, isolate/hide, section boxes, measurement, pins
- **Clash detection** — visual isolate of clashing element pairs, batched-retry resilient for large federated scenes
- **IDS checking** — Information Delivery Specification compliance, spec upload and results graph editor (`@xyflow/react`)
- **BCF issue collaboration** — topics, comments, viewpoints, Kanban board, BIMcollab-compatible
- **Model comparison** — cross-version diffing, category-level change summaries
- **4D planning** — native WBS/Gantt authoring, critical-path method (CPM), build-up playback against the 3D model
- **5D takeoff** — quantity and cost estimation from the normalized schema
- **Documents (ISO 19650 CDE)** — WIP → Shared → Published → Archived, app-enforced reviewed → approved → verified gate, purpose-of-issue suitability codes, advisory filename-convention checking, org-scoped WIP visibility for multi-contractor projects, drag-and-drop folders, bulk move/delete
- **Notifications** — in-app + email feed for uploads and status changes
- **Charts & analytics** (ECharts) — model composition, clash trends, schedule status
- **AI Assistant** — chat over your BIM data (OpenAI/Mistral/Ollama/LM Studio), semantic search over documents and elements
- **Auth** — dashboard login, session-based

## Configuration

This image bakes in no secrets or server URLs at build time. Instead, an Nginx `docker-entrypoint.d` script renders `config.js` from environment variables at **container start**, so the same image can be deployed against any backend. Key variables (see [`.env.example`](https://github.com/bau-tech/converge/blob/master/.env.example) in the source repo for the full list):

| Variable | Purpose |
|---|---|
| `VITE_SPECKLE_SERVER` / `VITE_SPECKLE_TOKEN` | Speckle server URL + personal access token |
| `VITE_EXTRA_SPECKLE_SERVERS` | Additional Speckle servers, for multi-server projects |
| `NORMALIZER_URL` / `BCF_SERVER_URL` | Internal proxy targets for `bim-normalizer` and `bcf-server` |
| `VITE_OLLAMA_BASE_URL` / `VITE_LMSTUDIO_BASE_URL` / `VITE_MISTRAL_API_KEY` | Optional local/hosted LLM backends for the AI Assistant |
| `VITE_SHARE_LINK_MODE` | Controls how public share links expose model data |

## Ports

- `80` — HTTP (map to whatever host port you like, e.g. `8080:80`)

## This image alone isn't the whole app

It needs `bim-normalizer` and `bcf-server` reachable behind it, and those in turn need PostgreSQL (and Nextcloud, for documents). See **Quick start** below for the one-command way to bring up everything together.

## The Converge stack

| Image | Role |
|---|---|
| **`euch/converge-dashboard`** (this image) | React frontend (Nginx) |
| [`euch/converge-normalizer`](https://hub.docker.com/r/euch/converge-normalizer) | Core API — ingestion, IFC export, clash/IDS checks, documents |
| [`euch/converge-bcf-server`](https://hub.docker.com/r/euch/converge-bcf-server) | BCF 2.1/3.0 issue-tracking API |
| [`euch/converge-mcp`](https://hub.docker.com/r/euch/converge-mcp) | MCP server — lets Claude query your BIM data |

## Quick start

Run the full stack with the sample [`docker-compose.release.yml`](https://github.com/bau-tech/converge/blob/master/docker-compose.release.yml) from the source repo:

```bash
git clone https://github.com/bau-tech/converge.git
cd converge
cp .env.example .env   # fill in Speckle server/token, Nextcloud admin creds, etc.
docker compose -f docker-compose.release.yml up -d
```

The dashboard is then available at `http://localhost:8080`.

## Tags

- `latest` — latest build of `master`
- `X.Y.Z` / `X.Y` — semver releases (git tags `vX.Y.Z`)
- short commit SHA — every push to `master`

## Source

[github.com/bau-tech/converge](https://github.com/bau-tech/converge) · also published to [GHCR](https://github.com/bau-tech/converge/pkgs/container/converge-dashboard)
