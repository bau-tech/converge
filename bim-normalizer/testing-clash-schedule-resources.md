# Testing: clash/schedule tools, caching, and MCP resources

Covers everything added in the second MCP-intelligence round, on top of the
[semantic search round](testing-semantic-search.md): `speckle_clash_check`, `speckle_schedule`,
`speckle_investigate_clashes`, `speckle_schedule_status_report`, `speckle_cache_clear`, and the
two `speckle://` resources.

## Important: no backend rebuild needed

Unlike the semantic search round, **this round only touches `converge_mcp.py`** — no new REST
endpoints, no schema changes, no new Python dependencies. It's a thin client over REST endpoints
that already existed (`/clash-check`, `/schedule`, `/models`, `/models/{id}/summary`).

- **Local (stdio)** — Claude Code re-reads `converge_mcp.py` the next time it (re)starts the MCP
  subprocess. If tools/resources from this round don't show up, restart your Claude Code session
  (or explicitly restart the MCP connection if your client exposes that).
- **Remote (streamable HTTP)** — only the `converge-mcp` container needs a rebuild, **not**
  `bim-normalizer`:
  ```bash
  docker compose up -d --build converge-mcp
  ```

## Testing `speckle_clash_check` / `speckle_investigate_clashes`

You need a model with elements from at least two overlapping categories to see a real clash.
Ask, in a Claude Code session:

> Use speckle_clash_check on model `<model_id>` with rules_json
> `[{"name": "Struct vs Arch", "selector_a": "IfcColumn", "selector_b": "IfcWall", "mode": "collision"}]`

Expect a per-rule pass/fail summary with counts. Then:

> Use speckle_investigate_clashes with the same arguments

Expect the same counts, but with clashing pairs grouped by IFC class (e.g. `IfcColumn ×
IfcWall: 4 instance(s)`) and a few named examples with distances — compare against what the
frontend's **Clash Check** panel shows for the same rule on the same model; the numbers should
match exactly (`speckle_investigate_clashes` reads the identical `clashes` array the frontend
panel is built from, it just formats it differently).

**Self-clash** (one category against itself): omit `selector_b`.
**Cross-model** (structure vs architecture as two separate ingested models): pass
`compare_model_id` — `selector_a` runs against `model_id`, `selector_b` against
`compare_model_id`.

If both come back with 0 clashes on a model you expect real clashes in, double check the
`selector_a`/`selector_b` IFC class names actually match what's in the model — try
`speckle_query_elements(model_id, ifc_class="IfcColumn")` first to confirm the class name and
that elements of it actually exist.

## Testing `speckle_schedule` / `speckle_schedule_status_report`

Needs a model with an imported 4D schedule (frontend Schedule widget → import IFC
`IfcWorkSchedule` or a Primavera P6 XML). Ask:

> Use speckle_schedule on model `<model_id>`

Expect an indented task tree with dates, `[CRITICAL]` tags on critical-path tasks, and element
counts per task. Then:

> Use speckle_schedule_status_report on model `<model_id>`

Expect four sections: task counts by status, critical-path tasks sorted by deadline, overdue
tasks (planned finish in the past, not marked complete), and tasks with zero linked elements.
Cross-check the overdue list — "planned finish in the past" is computed against the actual
current date/time at the moment you call the tool, so this list will genuinely change day to
day, unlike everything else in this doc which is deterministic given the same model.

If `speckle_schedule` reports "No schedule imported", that's the correct/expected behavior for a
model with no 4D data, not a bug — import one via the frontend first.

## Testing the cache (`speckle_cache_clear`)

> Call speckle_get_summary on model `<model_id>` twice in a row

The second call should return identical output much faster than the first (it's serving the
cached `requests.Response` from the first call instead of re-hitting the backend). Then:

> Call speckle_cache_clear, then speckle_get_summary again on the same model

The cache-clear response reports how many entries it dropped; the following `speckle_get_summary`
call re-fetches from the backend (you won't be able to *see* this from the tool's output alone
since the data is the same — the point is it's guaranteed-fresh, not that it looks different).

To actually observe a cache hit vs. miss, watch `bim-normalizer` request logs while calling the
same tool twice within 45 seconds — the second call should **not** produce a new
`GET /models/{id}/summary` log line:
```bash
docker compose logs bim-normalizer -f --tail 0
```

## Testing the resources

Resources are context, not actions — how you "call" them depends on the client:

- **Claude Code**: reference `@converge-mcp:speckle://models` or
  `@converge-mcp:speckle://models/<model_id>/summary` directly in a prompt, or use the client's
  resource-attachment UI if it has one (check `/mcp` or the paperclip/context menu).
- Expect JSON back (`mime_type="application/json"`) — a list of models for `speckle://models`,
  a single model's summary object for the templated one.

If a resource doesn't appear at all, confirm the MCP connection actually picked up this round's
code (see "Important: no backend rebuild needed" above) — resources require a client
(re)connection to be re-discovered, same as tools.

## Regression check

Spot-check one pre-existing tool (e.g. `speckle_qa_check`) still returns the same shape/content
as before — the cache swap changed *how* the response is fetched, not what it contains.
