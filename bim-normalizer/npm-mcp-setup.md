# Speckle MCP Server — Nginx Proxy Manager Setup

## Architecture

```
Claude Code (remote) ──HTTPS──► NPM (LXC) ──HTTP──► speckle-mcp container (port 8003)
                                                           │
                                                           └──► bim-normalizer:8002
```

## Step 1 — Generate an API key

On any machine:
```bash
openssl rand -hex 32
```

Set the result as `MCP_API_KEY` in the **root** `.env` (`z:\AppData\converge\.env` —
this is the compose file that actually defines the `speckle-mcp` service), then rebuild:
```bash
docker compose up -d --build speckle-mcp
```

Also set `MCP_ALLOWED_HOSTS` in the same `.env` to a comma-separated list of every
`Host` header the server should accept (the mcp SDK's DNS-rebinding protection rejects
anything else with `421 Invalid Host header`):
```
MCP_ALLOWED_HOSTS=mcp-speckle.example.com,192.168.1.10:8003
```
Include the public domain (Step 3) and the docker-host LAN IP:port (used by the
direct-LAN curl check in **Verify** below).

## Step 2 — Add a Proxy Host in NPM

Open Nginx Proxy Manager → **Proxy Hosts** → **Add Proxy Host**

| Field | Value |
|-------|-------|
| Domain name | `mcp-speckle.example.com` |
| Scheme | `http` |
| Forward hostname | `<docker-host LAN IP>` (e.g. `192.168.175.x`) |
| Forward port | `8003` |
| Block common exploits | ✓ |

**SSL tab**: enable, pick your existing wildcard cert or request a new Let's Encrypt cert.

**Advanced tab** — paste this custom nginx config:
```nginx
proxy_buffering    off;
proxy_cache        off;
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
```
These are required for the streamable HTTP transport's chunked/SSE responses to work correctly.

## Step 3 — Configure .mcp.json on each client machine

Replace the stdio entry with:
```json
{
  "mcpServers": {
    "speckle-ifc": {
      "type": "http",
      "url": "https://mcp-speckle.example.com/mcp",
      "headers": {
        "X-Api-Key": "<your MCP_API_KEY value>"
      }
    }
  }
}
```

> Note: `speckle_mcp.py` also supports `--transport sse` (legacy, endpoint `/sse`) for
> clients that don't yet support streamable HTTP. Prefer `streamable-http` /
> `"type": "http"` for new setups.

## Local machine (this server) — keep stdio

The local `.mcp.json` at `z:\AppData\converge\.mcp.json` stays as `stdio`.
It talks to `speckle_mcp.py` directly without going through NPM.

## Verify

```bash
# From the NPM LXC or any other machine on the LAN — check the MCP server is reachable
curl -i -X POST http://<docker-host-ip>:8003/mcp \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# Via NPM (public HTTPS)
curl -i -X POST https://mcp-speckle.example.com/mcp \
  -H "X-Api-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A working server returns `HTTP/1.1 200` with an `initialize` response (either as
`application/json` or a `text/event-stream` body) and an `Mcp-Session-Id` response header.
A `401 Unauthorized` means the key is wrong or not set in `.env`. A connection error or
`502/504` means NPM can't reach the container on port 8003.
