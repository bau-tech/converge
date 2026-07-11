# Testing semantic search & agentic workflow tools

Covers the three tools added on top of the existing 40+: `speckle_semantic_search`,
`speckle_investigate_element`, `speckle_full_qa_report`. See the README's
["Semantic search & agentic workflow tools"](../README.md#semantic-search--agentic-workflow-tools)
section for what each one does and why.

## Architecture recap

```
speckle_mcp.py (stdio or streamable-HTTP)
      │ REST (requests)
bim-normalizer  GET /models/{id}/elements/semantic-search
      │
db/query.py::semantic_search_elements
      │
search/embeddings.py   fastembed (BAAI/bge-small-en-v1.5) — local, CPU-only, no external API
      │
bim_element_embeddings  (element_id, embed_text, embedding FLOAT[])
```

Embeddings are built **automatically at ingest time** (`pipeline/normalize.py`,
`_build_missing_embeddings`) — there's no separate "build index" step to remember to run.
It's best-effort: a failure there is logged and skipped, it never fails the ingest itself.

## Step 1 — Rebuild and re-ingest

This is a backend-only change (`bim-normalizer`), no frontend rebuild needed.

```bash
# Rebuild bim-normalizer with the new fastembed/numpy dependencies
docker compose up -d --build bim-normalizer
```

The new `bim_element_embeddings` table is created automatically on startup
(`db/models.py`'s `SCHEMA_SQL` runs via `init_schema()` every boot — no manual migration).

Existing models have **no embeddings yet** — they were ingested before this feature existed.
Re-ingest one to backfill:

```bash
curl -X POST http://localhost:8002/ingest \
  -H "Content-Type: application/json" \
  -d '{"stream_id": "<your stream_id>", "commit_id": "<your commit_id>", "force": true}'

# Poll until complete
curl http://localhost:8002/ingest/status/<job_id>
```

Check the response (or the job status result) for `embedded_count` / `skip_embed_count` —
`embedded_count` should equal the model's element count (minus anything in `skip_embed_count`,
which should normally be 0). If `embedded_count` is 0 for a model with elements, see
**Troubleshooting** below.

You can also check directly against the database:
```sql
SELECT COUNT(*) FROM bim_element_embeddings
WHERE element_id IN (SELECT element_id FROM bim_elements WHERE model_id = '<model_id>');
```

## Step 2 — Verify the REST endpoint directly

```bash
curl "http://localhost:8002/models/<model_id>/elements/semantic-search?query=fire+rated+door&limit=5"
```

Expect `{"model_id", "query", "count", "elements": [{"element_id", "score", "ifc_class", ...}]}`.
An empty `elements` list with `count: 0` and a 200 (not 404) means the model has no embeddings —
re-check Step 1, not a bug in the query itself.

## Step 3 — Verify via the MCP tools

**Local (stdio)** — this repo's `.mcp.json` already wires up `speckle-ifc` for Claude Code; no
extra setup. Just ask, in a Claude Code session with this project open:

> Use speckle_semantic_search on model `<model_id>` to find "fire rated door"

> Use speckle_investigate_element on model `<model_id>` for "<some element name>"

> Run speckle_full_qa_report on model `<model_id>`

**Remote (streamable HTTP)** — if you're using the containerized `speckle-mcp` service instead
(see [`npm-mcp-setup.md`](npm-mcp-setup.md)), the same tools are available there — it's the same
`speckle_mcp.py` file, just running with `--transport streamable-http`. No separate deployment
step for the MCP server itself; rebuilding `bim-normalizer` is what matters, since these tools
are thin REST clients over it.

## What "good" looks like

- `speckle_semantic_search(model_id, "fire rated door")` returns plausible matches even when the
  literal words "fire rated door" don't appear in any element's name — that's the whole point,
  vs. `speckle_find_element` which only does exact/partial text match.
- Scores are cosine similarities (0–1, higher = more relevant) — a good match for a specific
  query is usually > 0.5; a generic/vague query will return everything clustered closer together
  and lower.
- `speckle_investigate_element` returns one report with three sections (Identity, Nearby, Data
  quality) instead of you having to call three-to-four tools yourself.
- `speckle_full_qa_report` lists issues in priority order (`weight × affected count`) with real
  example elements per category, not just the 3 samples `speckle_qa_check` shows.

## Troubleshooting

**`embedded_count` is 0 / semantic search always returns empty**
Check `bim-normalizer` logs for `Embedding batch failed` or `Loading semantic search embedding
model ...` around ingest time:
```bash
docker compose logs bim-normalizer --tail 100 | grep -i embed
```
Most likely cause: `fastembed` couldn't download `BAAI/bge-small-en-v1.5` on first use (no
internet access from the container, or a registry/firewall block). The model is small (~130MB)
and downloads once into the container's filesystem on first use — if the container has no
outbound internet access, pre-bake the model into the image or mount a volume with it
pre-downloaded instead.

**`speckle_semantic_search` works but scores all look similar/low**
The query might be too generic ("wall", "element") — try a more specific, descriptive phrase.
Also confirm you're querying the right `model_id` — a query against a model with very few
elements or very sparse parameters will have less to distinguish between.

**`speckle_investigate_element` can't resolve the element**
It tries semantic search first, then falls back to an exact/partial name match
(`speckle_find_element`'s underlying endpoint). If both come back empty, the element genuinely
isn't in that model, or the model still has no embeddings (see Step 1) *and* the name doesn't
substring-match either — try `speckle_find_element(query, model_id)` directly to confirm.

**Re-ingest doesn't seem to add new embeddings for an already-ingested model**
`force: true` re-runs classification, but embedding backfill (`get_element_ids_missing_embedding`)
only processes elements *without* a `bim_element_embeddings` row — already-embedded elements are
skipped (by design, to keep re-ingests of large models cheap). If you changed the embedding model
or text format and want to fully rebuild, delete the table's rows for that model first:
```sql
DELETE FROM bim_element_embeddings
WHERE element_id IN (SELECT element_id FROM bim_elements WHERE model_id = '<model_id>');
```
then re-ingest.
