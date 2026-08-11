# Testing the AI chat assistant

Covers `chat/agent.py` (the agentic tool-dispatch loop and its ~30 tools) and
the `/chat` / `/chat/stream` routes in `routers/chat.py`. Focused on what's
new: `get_schedule` / `get_element_tasks`, the extended `list_documents` /
`get_document_status` (folder, suitability code, naming compliance, linked
element, org-scoped WIP visibility), `check_federated_clashes`,
`get_notifications`, optional auth (`get_current_user_optional`), and the
native Anthropic (Claude) provider — not a re-test of every pre-existing tool.

`tests/test_chat_agent_dispatch.py` and `tests/test_anthropic_provider.py`
already cover tool-dispatch/argument-validation and the Anthropic
request/response converters as pytest unit tests against a mocked DB
connection (`pip install -r requirements.txt -r requirements-dev.txt &&
pytest tests/`). This doc is the complement — real end-to-end behavior
against a live database and, for the last section, the actual browser UI —
following the same convention as `testing-ifcx-export.md` etc.

## 1. Baseline sanity — plain chat still works

```bash
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "How many walls are in this model?", "history": []}' \
  | python3 -m json.tool
```

Expect `{"text": "...", "elementIds": [...], "toolsUsed": ["filter_elements"] or ["get_summary"], "reasoning": [...]}`.
No cookie is sent — confirms anonymous chat (the default for a `/shareXXX`
visitor) still works unchanged.

## 2. Schedule tools

Requires a model with an imported/generated schedule (`POST
/models/{id}/schedule/import` or `/schedule/generate` first — see the 4D
Timeline & Schedule routes in `docs/API_REFERENCE.md`).

```bash
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "What tasks are on the critical path?", "history": []}' \
  | python3 -m json.tool
```

`toolsUsed` should include `get_schedule`; the response text should only
reference tasks with `is_critical: true`. Then, with a specific element's
Speckle ID from that model:

```bash
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "What schedule task is element <speckle_id> part of?", "history": []}' \
  | python3 -m json.tool
```

`toolsUsed` should include `get_element_tasks`. Ask about an element with no
linked task too — expect a plain "no schedule tasks linked" answer, not an
error.

## 3. Document tools — folder, suitability, and org-scoped WIP visibility

Upload one document as each of two different organizations' users (see
`bcf-server`'s admin panel for org assignment), both left in `01_WIP`, then:

```bash
# Anonymous — should NOT see either org's WIP-status document (only
# unscoped WIP, if any), but should still see non-WIP documents normally.
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "What documents are in the Structural folder?", "history": []}' \
  | python3 -m json.tool
```

```bash
# Logged in as org A's user — should see org A's WIP doc, not org B's.
curl -sX POST "http://<host>:<port>/auth/login" -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"email": "<org-a-user-email>", "password": "<password>"}'

curl -sX POST "http://<host>:<port>/chat" -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "What documents are in WIP?", "history": []}' \
  | python3 -m json.tool
```

Each returned document summary should include `folder`, `suitability_code`,
`naming_compliant`, and `linked_element` alongside the pre-existing
`status`/`revision`/`reviewed`/`approved`/`verified` fields. Ask "is
`<filename>` approved?" too — `get_document_status` should return the same
org-scoped result (a WIP document outside the asker's org should read as not
found, matching `GET .../documents/{doc_id}`'s own 404 behavior).

## 4. Federated (cross-model) clash checking

```bash
# Missing compared_model_id/selector_a — should fail gracefully, not 500
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id_a>", "message": "Check federated clashes", "history": []}'
```

```bash
# Real cross-model run (structure vs architecture, or any two ingested models)
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id_a>", "message": "Check columns in this model against walls in model <model_id_b> for clashes", "history": []}' \
  | python3 -m json.tool
```

`toolsUsed` should include `check_federated_clashes`. If any clashes are
found and `model_id_a`'s IFC source is a synthetic export, `elementIds`
should be populated (model A's elements only — model B's clashing elements
are named in the text, never highlighted, since the viewer only has model A
loaded).

## 5. Notifications

```bash
# Anonymous — graceful "requires being logged in", not an error
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "Do I have any notifications?", "history": []}'

# Logged in (reuse cookies.txt from step 3) — real notification list
curl -sX POST "http://<host>:<port>/chat" -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "Any unread notifications for me?", "history": []}' \
  | python3 -m json.tool
```

## 6. Anthropic (Claude) provider, end-to-end

```bash
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "How many walls are in this model?", "history": [],
       "ai_provider": "anthropic",
       "anthropic_config": {"apiKey": "<your Anthropic key>", "model": "claude-sonnet-5"}}' \
  | python3 -m json.tool
```

Then the streaming variant — confirm `text_delta` events arrive incrementally
(not all at once) and a tool actually gets called for a query that needs one:

```bash
curl -sN -X POST "http://<host>:<port>/chat/stream" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "Break down volume by category", "history": [],
       "ai_provider": "anthropic",
       "anthropic_config": {"apiKey": "<your Anthropic key>", "model": "claude-sonnet-5"}}'
```

Expect a `tool_start`/`tool_done` pair for `get_summary` (or similar) among
the SSE events, then `text_delta` events, then `elements`/`done` — same event
shape as every other provider, confirming the Anthropic response/stream
converters produce output indistinguishable from the OpenAI-compatible path
to everything downstream.

## 7. Report generation tool + tool-call resilience

The `generate_report` tool shares `reports/generate.py` with the REST
endpoint and MCP server — see `testing-reports.md` for full report-type/
format coverage and its "cross-surface consistency" step (generate the same
report via REST, chat, and MCP, confirm identical content). Here, just
confirm the tool is reachable from chat at all:

```bash
curl -sX POST "http://<host>:<port>/chat" \
  -H 'Content-Type: application/json' \
  -d '{"model_id": "<model_id>", "message": "Generate a bill of materials report", "history": []}' \
  | python3 -m json.tool
```

Expect a `generate_report` tool call and a text response describing the
generated file (chat has no live 3D viewer, so a `model_summary` request
here should still succeed, just without a 3D-view section — same as the
MCP surface).

Two narrower resilience checks worth confirming after touching the tool
dispatch loop (`run_chat_agent`/`stream_chat_agent` in `chat/agent.py`):

- **Malformed tool-call JSON shouldn't crash the whole turn.** Hard to
  trigger from a well-behaved hosted provider — this mostly matters with
  local ollama/lmstudio backends, which are more prone to truncated/invalid
  JSON in tool-call arguments. If you hit one, confirm the chat response
  still completes (with the model retrying or explaining the failure)
  instead of the request just dying with a 500.
- **`get_qa_elements` ignores an absurd `limit`.** Ask something like "show
  me 999999 unclassified elements" and confirm the tool result stays
  bounded (500 rows max — `min(int(args.get("limit") or 50), 500)`) rather
  than dumping an unbounded result into the conversation's token context.

## 8. Manual UI spot-check (required once per non-trivial change to this feature)

Open the dashboard, open the AI Assistant chat widget, open Settings, and
confirm a fifth **Claude** provider tab is selectable alongside
OpenAI/Mistral/Ollama/LM Studio, with its own API key + model fields that
persist across a page reload (localStorage). Send a message that should
trigger `get_schedule` and confirm the critical-path tasks' elements
highlight in the 3D viewer, exactly like `check_clashes`/`filter_elements`
already do. This is the only step that confirms the whole stack — real
browser, real provider call, real viewer sync — not just that the backend's
JSON is self-consistent.
