<p align="center">
  <img src="https://raw.githubusercontent.com/bau-tech/converge/master/public/converge-logo2-transparent.png" alt="Converge logo" width="120">
</p>

# Converge BCF Server

The issue-tracking API of **Converge** — a BIM coordination, analytics, and collaboration platform built on [Speckle](https://speckle.systems/). This is a deliberately slim FastAPI (Python 3.11) image split out of the main normalizer service, since `bcf_server.py` only ever does BCF topic/comment/viewpoint CRUD, its own admin panel, and OAuth — it never touches `ifcopenshell`, `numpy`, `fastembed`, or any of the other heavy dependencies the normalizer image carries for IFC/clash/document work. Sharing that ~800MB image just for this one entrypoint wasn't worth it, so this image ships with its own minimal `requirements-bcf-server.txt`.

## What's inside

- **BCF 2.1 / 3.0 API** — full topic/comment/viewpoint CRUD per the open BCF spec
- **BIMcollab-compatible OAuth shim** — so BIMcollab desktop/plugin clients can connect directly
- **Kanban-friendly comment sync** — keeps topic creation and comment threads consistent under concurrent edits (delete races, topic-creation races)
- **Shared data plane** — reads/writes the same `bim_models`/`bim_elements` tables as `converge-normalizer`, over the same PostgreSQL instance, so BCF viewpoints stay linked to live model elements
- **Admin panel** — user/project administration for BCF access

## Configuration

Full variable list in [`.env.example`](https://github.com/bau-tech/converge/blob/master/.env.example) in the source repo. The main ones:

| Variable | Purpose |
|---|---|
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_PASS` / `PG_NAME` | PostgreSQL connection (same instance as `converge-normalizer`) |
| `BCF_API_KEY` | API key for BCF client authentication |
| `BCF_OIDC_SECRET` | OAuth shim secret for BIMcollab clients |
| `BCF_ADMIN_EMAIL` / `BCF_ADMIN_PASSWORD` | Bootstrap admin account |
| `SPECKLE_SERVER_URL` / `SPECKLE_TOKEN` | Speckle server for viewpoint-to-element linking |

## Ports & health

- `8004` — HTTP API
- Healthcheck: `GET /health`

## Requirements

Needs the same PostgreSQL instance as `converge-normalizer`, and typically runs alongside it (some routes assume the normalizer's schema already exists). See **Quick start** below for the one-command way to bring up the whole stack together.

## The Converge stack

| Image | Role |
|---|---|
| [`euch/converge`](https://hub.docker.com/r/euch/converge) | Stack overview — start here |
| [`euch/converge-dashboard`](https://hub.docker.com/r/euch/converge-dashboard) | React frontend (Nginx) |
| [`euch/converge-normalizer`](https://hub.docker.com/r/euch/converge-normalizer) | Core API — ingestion, IFC export, clash/IDS checks, documents |
| **`euch/converge-bcf-server`** (this image) | BCF 2.1/3.0 issue-tracking API |
| [`euch/converge-mcp`](https://hub.docker.com/r/euch/converge-mcp) | MCP server — lets Claude query your BIM data |

## Quick start

```bash
git clone https://github.com/bau-tech/converge.git
cd converge
cp .env.example .env   # fill in Speckle server/token, Nextcloud admin creds, etc.
docker compose -f docker-compose.release.yml up -d
```

The API is then available at `http://localhost:8004`.

## Tags

- `latest` — latest build of `master`
- `X.Y.Z` / `X.Y` — semver releases (git tags `vX.Y.Z`)
- short commit SHA — every push to `master`

## Source

[github.com/bau-tech/converge](https://github.com/bau-tech/converge) · also published to [GHCR](https://github.com/bau-tech/converge/pkgs/container/converge-bcf-server)
