# MCP Server Tool Reference

Full tool catalog for `converge_mcp.py`, split out of the main [README](../README.md) to keep that file focused on onboarding. See the README's [MCP server](../README.md#mcp-server-converge_mcppy) section for local/remote setup.

---

## Tool groups

#### IFC session tools
Work on an in-memory `ifcopenshell` model loaded with `ifc_load` — or with `speckle_load(model_id)`,
which bridges a normalizer-ingested model into the session by exporting it via the normalizer's own
`/models/{id}/export/ifc` job endpoints (`routers/ifc_export.py`) and loading the result, fast-pathing
through the original uploaded IFC blob when the source model came from one.

| Tool | Description |
|------|-------------|
| `ifc_new` | Create empty IFC model |
| `ifc_load(path)` | Load a local `.ifc` file |
| `speckle_load(model_id, coord_unit?)` | Export a normalizer-ingested model as IFC and load it into this session |
| `ifc_reset` | Unload current model |
| `ifc_save(path)` | Save to disk |
| `ifc_summary` | Schema, project name, entity counts |
| `ifc_tree` | Spatial hierarchy (Project → Site → Building → Storey) |
| `ifc_info(element_id)` | All attributes + property sets for one element |
| `ifc_select(ifc_class)` | List all elements of a class (e.g. `IfcWall`) |
| `ifc_relations(element_id)` | All relationships an element participates in |
| `ifc_materials` | All material definitions |
| `ifc_write_pset(element_ids, pset_name, properties)` | Write/update a property set on one or more elements |

#### Speckle server tools (GraphQL)
| Tool | Description |
|------|-------------|
| `speckle_list_projects` | List projects on the Speckle server |
| `speckle_list_models(project_id)` | List models (branches) in a project |
| `speckle_list_versions(project_id, model_name)` | List commits |

#### Normalizer tools (REST)
| Tool | Description |
|------|-------------|
| `speckle_list_ingested` | All models in PostgreSQL |
| `speckle_get_summary(model_id)` | Category / storey / material breakdown |
| `speckle_query_elements(model_id, ...)` | Filtered element query |
| `speckle_query_by_parameter(model_id, ...)` | Filter elements by arbitrary parameter key/value |
| `speckle_find_nearby(model_id, speckle_id, radius_m)` | Elements within a radius of a given element |
| `speckle_parameter_keys(model_id)` | Distinct parameter keys present on a model |
| `speckle_get_materials(model_id)` | Material definitions used in a model |
| `speckle_get_profiles(model_id)` | Structural profile definitions used in a model |
| `speckle_ingest(stream_id, commit_id)` | Ingest a Speckle commit (waits for completion) |
| `speckle_export_csv(model_id, ...)` | Export elements/parameters as CSV |

#### Filters & overrides tools
| Tool | Description |
|------|-------------|
| `speckle_list_overrides(model_id)` | List manual property overrides |
| `speckle_set_overrides(model_id, overrides_json)` | Create/update overrides |
| `speckle_apply_overrides(model_id)` | Apply pending overrides to stored elements |
| `speckle_filter_publish(model_id, ...)` | Publish a filtered element subset back to Speckle |
| `classification_reload` | Hot-reload classification rules |

#### Intelligence tools
| Tool | Description |
|------|-------------|
| `speckle_get_object(stream_id, object_id)` | Raw Speckle object properties (streaming) |
| `speckle_element_detail(element_id)` | Full element: geometry quantities + all parameter sets |
| `speckle_diff_models(model_id_a, model_id_b)` | Added / removed / changed + per-category deltas |
| `speckle_qa_check(model_id)` | 0–1 quality score with per-issue breakdown and sample IDs |
| `speckle_qa_elements(model_id, issue, limit?)` | Elements behind a specific QA issue |
| `speckle_compare_categories(model_ids)` | Side-by-side category table for up to 6 models |
| `speckle_find_element(query, model_id?)` | Name search across all ingested models |
| `speckle_quantities(model_id, group_by?)` | Fast quantity takeoff from the DB — no IFC load required. `group_by`: `ifc_class` (default) \| `category` \| `storey` |
| `speckle_cost_estimate(model_id, rates_json, group_by?)` | Apply unit rates to quantities for a rough cost estimate |
| `speckle_trend_analysis(model_id, limit?)` | Element/category counts across versions of a stream |

#### Semantic search & agentic workflow tools
Semantic search runs against embeddings computed automatically at ingest time (local CPU model,
`search/embeddings.py` — no external API, no pgvector). The workflow tools are deterministic,
hardcoded chains of the primitive tools above (no LLM reasoning happens inside the server) that
return one consolidated report instead of requiring several separate calls.

| Tool | Description |
|------|-------------|
| `speckle_semantic_search(model_id, query, limit?)` | Find elements by meaning rather than exact text — e.g. `"fire rated door"` matches even if those exact words never appear in the element's name/parameters |
| `speckle_investigate_element(model_id, query, radius_m?)` | Resolves an element by name/description, then reports identity + parameters, nearby elements, and QA flags in one call — chains semantic search → `speckle_element_detail` → `speckle_find_nearby` → `speckle_qa_check` |
| `speckle_full_qa_report(model_id)` | Full data-quality report: score, model context, real example elements per issue category (not just the 3 samples `speckle_qa_check` shows), and a fix list prioritized by weight × affected-count |
| `speckle_investigate_clashes(model_id, rules_json, compare_model_id?)` | Runs clash detection and reports which categories/elements are actually colliding and where (grouped example pairs + distances), not just a count |
| `speckle_schedule_status_report(model_id)` | Schedule health in one call: task counts by status, critical-path tasks, overdue tasks, and tasks with no elements linked |

See [`bim-normalizer/testing-semantic-search.md`](../bim-normalizer/testing-semantic-search.md) for how to verify these end-to-end after rebuilding.

#### Clash & schedule tools
Primitive building blocks the two workflow tools above are built on — use these directly when
you just need the raw result rather than a synthesized report.

| Tool | Description |
|------|-------------|
| `speckle_clash_check(model_id, rules_json, compare_model_id?)` | Run BVH mesh-level clash detection (ifcclash) and wait for the result (blocking, up to 5 min). `rules_json`: JSON array of `{name?, selector_a, selector_b?, mode?, tolerance?, clearance?}` |
| `speckle_schedule(model_id)` | Full 4D task schedule tree — name, WBS code, status, dates, critical-path flag, linked element count |

#### Documents & BCF tools
Mirror the Documents and BCF REST APIs above, for use from Claude without going through the
dashboard UI. Document and notification tools need a real dashboard login
(`MCP_DASHBOARD_EMAIL`/`_PASSWORD`, or the `BCF_ADMIN_EMAIL`/`_PASSWORD` fallback) since they're
role-gated; BCF topic tools work with just `BCF_API_KEY`.

| Tool | Description |
|------|-------------|
| `speckle_list_documents(stream_id, status?, folder_path?, linked_element?)` | List documents for a project, optionally scoped to one folder or one linked element |
| `speckle_document_detail(stream_id, doc_id)` | Metadata + audit event history |
| `speckle_upload_document(stream_id, ...)` | Upload a document — lands in `01_WIP` |
| `speckle_move_document(stream_id, doc_id, status)` | Move between WIP/Shared/Published/Archived (app-enforced gate) |
| `speckle_set_document_review(stream_id, doc_id)` / `speckle_set_document_approval(...)` / `speckle_set_document_verification(...)` | Set the reviewed / approved / verified stage |
| `speckle_link_document_topic(stream_id, doc_id, topic_id)` / `speckle_link_document_element(...)` | Link a document to a BCF topic or model element |
| `speckle_delete_document(stream_id, doc_id)` | Soft-delete (audit trail survives) |
| `speckle_list_notifications(unread_only?, limit?)` | The logged-in MCP dashboard user's own notifications, across every project |
| `speckle_list_topics(stream_id)` | List BCF topics for a project |
| `speckle_topic_detail(stream_id, topic_id)` | Full topic detail |
| `speckle_create_topic(stream_id, ...)` / `speckle_update_topic(...)` | Create/update a BCF topic |
| `speckle_list_comments(stream_id, topic_id)` / `speckle_add_comment(...)` | List/add topic comments |
| `speckle_list_viewpoints(stream_id, topic_id)` | List topic viewpoints |
| `speckle_list_ids_specs(model_id)` / `speckle_upload_ids_spec(...)` / `speckle_delete_ids_spec(...)` | List/store/delete IDS specifications |
| `speckle_ids_check(model_id, spec_id)` | Run an IDS spec against the model via `ifctester` |

#### Cache maintenance
Read-heavy tools (`speckle_get_summary`, `speckle_qa_check`, `speckle_qa_elements`,
`speckle_semantic_search`, `speckle_parameter_keys`, `speckle_get_materials`,
`speckle_get_profiles`, and the workflow tools' internal calls to those same endpoints) share a
45-second in-process cache in `converge_mcp.py` — smooths a burst of related calls in one exchange
without ever risking staleness beyond well under a minute. Every write/mutating call bypasses it
entirely.

| Tool | Description |
|------|-------------|
| `speckle_cache_clear()` | Force-clear the cache — use right after a re-ingest if you need the very next read to be guaranteed-fresh |

#### Resources (browsable context, not tool calls)
| URI | Description |
|-----|-------------|
| `speckle://models` | All ingested models — id, stream, source, element count |
| `speckle://models/{model_id}/summary` | One model's category/IFC-class/storey/material summary |

See [`bim-normalizer/testing-clash-schedule-resources.md`](../bim-normalizer/testing-clash-schedule-resources.md)
for how to verify the clash/schedule tools, cache, and resources end-to-end. Unlike the semantic
search round, this one only touches `converge_mcp.py` — no `bim-normalizer` rebuild needed.

#### 5D / Quantity tools (IFC session)
Work on the model loaded with `ifc_load` (see the `speckle_load` bug note above — there is
currently no MCP path to load a normalizer-ingested model here).

| Tool | Description |
|------|-------------|
| `ifc5d_quantities(group_by?)` | Aggregate quantity takeoff from IfcElementQuantity sets. `group_by`: `ifc_class` (default) \| `storey` \| `material` |
| `ifc5d_cost_schedule()` | List IfcCostSchedule hierarchies with cost items and referenced quantities |
| `ifc5d_boq_export(output_path?)` | Export a Bill of Quantities as CSV; returns the path or the CSV content |
