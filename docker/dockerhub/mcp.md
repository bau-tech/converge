<p align="center">
  <img src="https://raw.githubusercontent.com/bau-tech/converge/master/public/converge-logo2-transparent.png" alt="Converge logo" width="120">
</p>

# Converge MCP Server

The AI-copilot entry point of **Converge** — a BIM coordination, analytics, and collaboration platform built on [Speckle](https://speckle.systems/). This image runs a [FastMCP](https://github.com/jlowin/fastmcp) server (85 tools, 2 resources) so Claude Code or Claude.ai can query and reason over your BIM data in natural language, backed by an in-memory `ifcopenshell`/`ifc5d` IFC session plus a thin REST/GraphQL client over the rest of the stack.

Like `converge-bcf-server`, this is a deliberately slim image split out of the main normalizer build — `converge_mcp.py` never touches `fastapi`, `psycopg2`, `specklepy`, `ifctester`, `ifcclash`, `numpy`, `fastembed`, `ezdxf`, `cairosvg`, `python-docx`, `openpyxl`, or `reportlab`, so it ships its own minimal `requirements-converge-mcp.txt` instead of inheriting the ~800MB normalizer image.

## What's inside

- **85 MCP tools + 2 resources** covering: element search and detail lookup, quantities/cost estimation, clash-check results, BCF issue topics/comments, IDS compliance checks, document read/search (including local PDF text extraction via `poppler-utils`), Speckle project/model/version management, schedule/status queries, and semantic search
- **In-memory IFC editing session** — load, inspect, edit, and save IFC files directly via `ifcopenshell`/`ifc5d`, independent of the normalizer's PostgreSQL-backed data
- **Two transports** — stdio for local Claude Code use, or streamable-HTTP (this image's default, port `8003`) for remote/shared access
- **Speckle-native tools** — talks to Speckle servers directly via `specklepy`/GraphQL for stream, commit, and object-level queries, not just through the normalizer's cached schema

## Configuration

Full variable list in [`.env.example`](https://github.com/bau-tech/converge/blob/master/.env.example) in the source repo. The main ones:

| Variable | Purpose |
|---|---|
| `SPECKLE_SERVER_URL` / `SPECKLE_TOKEN` | Speckle server for direct-Speckle tools |
| `VITE_EXTRA_SPECKLE_SERVERS` | Additional Speckle servers for multi-server projects |
| `NORMALIZER_URL` | Internal URL to `converge-normalizer`, for schema-backed tools |
| `MCP_API_KEY` / `MCP_ALLOWED_HOSTS` | Access control for the remote HTTP transport |
| `BCF_SERVER_URL` / `BCF_API_KEY` | BCF tool access |
| `MCP_DASHBOARD_EMAIL` / `MCP_DASHBOARD_PASSWORD` | Credentials for tools that act through the dashboard's own auth |

## Ports & health

- `8003` — streamable-HTTP MCP endpoint
- No healthcheck — the streamable-HTTP transport exposes no separate `/health` route

## Requirements

Needs `converge-normalizer` reachable for schema-backed tools (element/document/quantity queries); direct-Speckle tools work with just Speckle server credentials. See **Quick start** below for the one-command way to bring up the whole stack together.

## The Converge stack

| Image | Role |
|---|---|
| [`euch/converge`](https://hub.docker.com/r/euch/converge) | Stack overview — start here |
| [`euch/converge-dashboard`](https://hub.docker.com/r/euch/converge-dashboard) | React frontend (Nginx) |
| [`euch/converge-normalizer`](https://hub.docker.com/r/euch/converge-normalizer) | Core API — ingestion, IFC export, clash/IDS checks, documents |
| [`euch/converge-bcf-server`](https://hub.docker.com/r/euch/converge-bcf-server) | BCF 2.1/3.0 issue-tracking API |
| **`euch/converge-mcp`** (this image) | MCP server — lets Claude query your BIM data |

## Quick start

```bash
git clone https://github.com/bau-tech/converge.git
cd converge
cp .env.example .env   # fill in Speckle server/token, MCP creds, etc.
docker compose -f docker-compose.release.yml up -d
```

The MCP endpoint is then available at `http://localhost:8003`.

## Tags

- `latest` — latest build of `master`
- `X.Y.Z` / `X.Y` — semver releases (git tags `vX.Y.Z`)
- short commit SHA — every push to `master`

## Source

[github.com/bau-tech/converge](https://github.com/bau-tech/converge) · also published to [GHCR](https://github.com/bau-tech/converge/pkgs/container/converge-mcp)
