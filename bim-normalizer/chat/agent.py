"""
BIM Chat Agent — agentic loop with tool execution and SSE streaming.

Items implemented here:
 5. Chain-of-thought reasoning instruction + intermediate reasoning capture
 6. Typed numeric parameter comparisons (op: gt/lt/gte/lte/eq/contains)
 7. Model diff awareness via get_model_changes tool
 9. stream_chat_agent generator for SSE streaming
"""
import asyncio
import concurrent.futures
import json
import logging
import time
import uuid
from collections import Counter
from decimal import Decimal
from typing import Generator

import requests

# Tool-call rounds per user turn. Was 5 — a genuinely multi-step question
# ("check clashes, then check IDS compliance, then open a BCF issue" is 3+
# tool calls plus the final answer round) could silently hit the cap and
# return "I reached the response limit" instead of finishing.
MAX_TOOL_ROUNDS = 10


def _jdump(obj) -> str:
    """json.dumps that converts Decimal (psycopg2 NUMERIC) to float."""
    return json.dumps(obj, default=lambda v: float(v) if isinstance(v, Decimal) else str(v))

from db.query import (
    get_model_qa,
    get_parameter_completeness,
    get_model_stream_id,
    get_model_trend,
    find_nearby_elements,
    get_qa_elements,
    get_element_details,
    semantic_search_elements,
    _steel_element_ids,
    get_element_relationships,
    get_element_connectivity,
    get_model_diff,
    get_quantity_takeoff,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "filter_elements",
            "description": (
                "Filter BIM elements by category, IFC class, storey/level, or name. "
                "Returns matching Speckle IDs for 3D viewer highlighting. "
                "Call this when the user wants to see or isolate specific elements."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "Element category, e.g. Walls, Columns, Floors, Beams"},
                    "ifc_class": {"type": "string", "description": "IFC class, e.g. IfcWall, IfcColumn, IfcBeam"},
                    "storey": {"type": "string", "description": "Building storey / level name"},
                    "name": {"type": "string", "description": "Partial element name match"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": (
                "Get aggregate counts and quantities (volume, area) grouped by category, "
                "storey, or IFC class. Use this to answer quantity / statistics questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "group_by": {
                        "type": "string",
                        "enum": ["category", "storey", "ifc_class"],
                        "description": "Dimension to group by",
                    },
                },
                "required": ["group_by"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_by_parameter",
            "description": (
                "Find elements by any BIM parameter key/value pair. "
                "Searches the full parameter database — use for material, profile, grade, fire rating, "
                "structural section, coating, or any other property not covered by filter_elements. "
                "Supports text matching (contains/eq) and numeric comparisons (gt/lt/gte/lte). "
                "Also highlights matched elements in the 3D viewer."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Parameter key to search (case-insensitive partial match). Check Available Parameter Keys in context.",
                    },
                    "value": {
                        "type": "string",
                        "description": "Value to match. For numeric ops, provide the number as a string (e.g. '5.0').",
                    },
                    "op": {
                        "type": "string",
                        "enum": ["contains", "eq", "gt", "lt", "gte", "lte"],
                        "description": (
                            "Comparison operator: "
                            "contains=partial text match (default), "
                            "eq=exact text match, "
                            "gt/lt/gte/lte=numeric comparison using stored numeric value."
                        ),
                    },
                    "category": {
                        "type": "string",
                        "description": "Optional: also filter by element category.",
                    },
                    "storey": {
                        "type": "string",
                        "description": "Optional: also filter by storey/level name.",
                    },
                },
                "required": ["key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_materials",
            "description": (
                "List all distinct materials used in the model with element counts and total volumes. "
                "Use for questions like 'what materials are in this model?', 'how much concrete is there?', "
                "'break down volumes by material'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Optional: restrict to one element category.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_profiles",
            "description": (
                "List all structural profiles (HEA200, IPE300, etc.) and steel grades (S235, S355, etc.) "
                "with element counts and volumes. Use for steel structure queries."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "estimate_cost",
            "description": (
                "Apply unit rates to model quantities to produce a rough cost estimate (5D). "
                "Use when the user gives a rate (e.g. '180 EUR per m3 of concrete', '40 USD per m2 of "
                "flooring') and asks for a cost, budget, or price estimate. "
                "Each rate rule matches group names by case-insensitive substring against the "
                "group_by dimension (e.g. rule match='Concrete' matches a category named 'Concrete Walls'). "
                "Groups with no matching rule are listed separately so the rate card can be extended — "
                "always mention them to the user rather than silently omitting them from the total."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "rates": {
                        "type": "array",
                        "description": (
                            "Rate rules, e.g. "
                            "[{\"match\":\"Concrete\",\"unit\":\"m3\",\"rate\":180,\"currency\":\"EUR\"}, "
                            "{\"match\":\"Steel\",\"unit\":\"m3\",\"rate\":7800,\"currency\":\"EUR\"}]"
                        ),
                        "items": {
                            "type": "object",
                            "properties": {
                                "match": {
                                    "type": "string",
                                    "description": "Substring to match against the group name (case-insensitive).",
                                },
                                "unit": {
                                    "type": "string",
                                    "enum": ["m3", "m2", "count"],
                                    "description": "m3=volume, m2=area, count=element count.",
                                },
                                "rate": {"type": "number", "description": "Cost per unit."},
                                "currency": {
                                    "type": "string",
                                    "description": "Optional currency label, e.g. EUR, USD. Rules with "
                                                    "different currencies are subtotaled separately, never summed together.",
                                },
                            },
                            "required": ["match", "unit", "rate"],
                        },
                    },
                    "group_by": {
                        "type": "string",
                        "enum": ["category", "storey", "ifc_class"],
                        "description": "Dimension to group quantities by before applying rates. Defaults to category.",
                    },
                },
                "required": ["rates"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_model_changes",
            "description": (
                "Compare the current model against a previous version to see what elements were added, "
                "removed, or modified. Returns counts by category and highlights newly added elements "
                "in the 3D viewer. Use when the user asks 'what changed?', 'what's new?', "
                "'compare versions', or 'show added elements'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "compared_to": {
                        "type": "string",
                        "description": "The model_id UUID of the baseline/previous version to compare against.",
                    },
                },
                "required": ["compared_to"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_data_quality",
            "description": (
                "Run a BIM data-quality assessment on the current model: a 0-1 quality score plus "
                "issue breakdowns for unclassified elements, missing geometry, missing names, "
                "missing storeys, missing materials, and duplicate IDs (with sample element IDs). "
                "Use when the user asks 'what's wrong with this model?', 'how good is the data?', "
                "'data quality', or 'QA report'."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_parameter_completeness",
            "description": (
                "Get the fill-rate (coverage %) of BIM parameters across elements, sorted worst-first. "
                "Use when the user asks 'which parameters are missing?', 'is fire rating filled in?', "
                "'how complete is this model's data?', or to find parameters that need cleanup."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "description": "Optional: restrict to elements of this category."},
                    "ifc_class": {"type": "string", "description": "Optional: restrict to elements of this IFC class."},
                    "min_coverage": {
                        "type": "number",
                        "description": "Optional: only return parameters with coverage at or above this percent (0-100). Use 0 (default) to see the worst-covered parameters first.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_version_history",
            "description": (
                "Get the version history for the current model's stream: element counts, volume (m3), "
                "and area (m2) — overall and per category — for every ingested version, ordered oldest "
                "to newest. Use when the user asks 'how has this model evolved?', 'show version history', "
                "'what's the trend over versions?', or construction-monitoring questions like "
                "'is concrete volume growing as planned per pour?' or 'how has structural volume trended "
                "across versions?'. For comparing two specific versions element-by-element (added/removed/ "
                "changed), use get_model_changes instead."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_nearby_elements",
            "description": (
                "Find elements within a radius (in meters) of a reference element or coordinate. "
                "Use when the user asks 'what's near X?', 'find elements within Nm of...', "
                "or refers to 'the selected element/object' — use its Speckle ID from the "
                "Currently Selected Element context as the reference. "
                "Only works for elements ingested with SI geometry data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "Speckle ID or (partial) name of the reference element to search around.",
                    },
                    "radius_m": {
                        "type": "number",
                        "description": "Search radius in meters.",
                    },
                    "category": {
                        "type": "string",
                        "description": "Optional: restrict results to this element category.",
                    },
                },
                "required": ["reference", "radius_m"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_related_elements",
            "description": (
                "Get elements directly related to a given element via parent/room/space "
                "references — e.g. a device's host wall, the room/space it's located in, "
                "or everything hosted by/located in a given element. Use for 'what wall is "
                "this hosted on?', 'what's in this room?', 'what room is this in?', or similar "
                "containment/hosting questions. Only reflects relationships captured at ingest "
                "time (Revit parent/room/space references) — returns nothing for models "
                "without that data, or where the referenced elements (e.g. Rooms) weren't "
                "themselves ingested."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "Speckle ID or (partial) name of the element to look up relationships for.",
                    },
                },
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_connectivity",
            "description": (
                "Trace what an element is connected to, possibly through intermediate elements — "
                "e.g. 'what's connected to this beam', 'trace this duct run', 'what's near this wall "
                "structurally and physically'. Combines get_related_elements' parent/room/space links, "
                "real IFC relationships where the model has a usable IFC representation (aggregation, "
                "spatial containment, physical connections, openings), and geometric bounding-box "
                "touching — the one signal available for every model regardless of source. Walks "
                "multiple hops outward, unlike get_related_elements (one hop only)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "Speckle ID or (partial) name of the element to trace connectivity from.",
                    },
                    "hops": {
                        "type": "integer",
                        "description": "How many relationship hops to walk outward (default 2, clamped 1-3).",
                    },
                },
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_qa_elements",
            "description": (
                "Get the actual elements affected by a specific data-quality issue, for highlighting "
                "in the 3D viewer. Use after check_data_quality when the user wants to see/select the "
                "problem elements, e.g. 'show me the elements with no name', 'highlight unclassified elements'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "issue": {
                        "type": "string",
                        "enum": ["unclassified", "no_geometry", "no_name", "no_storey", "no_material", "duplicate_ids"],
                        "description": "Which QA issue to drill into.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max elements to return (default 50).",
                    },
                },
                "required": ["issue"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_element_details",
            "description": (
                "Get full details for one specific element — category, IFC class, storey, bounding "
                "box, centroid, volume, area, and every parameter/value. Use when the user asks about "
                "'the selected element/object' (use its Speckle ID from context), or names/IDs a "
                "specific element and wants to know its properties."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {
                        "type": "string",
                        "description": "Speckle ID or (partial) name of the element to look up.",
                    },
                },
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "semantic_search",
            "description": (
                "Find elements by meaning rather than exact text match — describe what you're "
                "looking for in plain language (e.g. 'fire rated door', 'load bearing column on "
                "the ground floor') and get back the closest matches, even if the words don't "
                "literally appear in the element's name or parameters. Prefer this over "
                "query_by_parameter/filter_elements when you don't know the exact field names or "
                "wording used in the source model. Requires the model to have been ingested after "
                "semantic search existed — an empty result means no embeddings, not no matches."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Free-text description of what to find."},
                    "limit": {"type": "integer", "description": "Max results (default 10)."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_clashes",
            "description": (
                "Run geometric clash detection between two categories/IFC classes in this model "
                "(e.g. structural columns vs walls) and highlight the colliding elements in the 3D "
                "viewer. Use when the user asks to 'check for clashes', 'find collisions', or "
                "'does X clash with Y'. Can take up to a minute or more for a large model."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "selector_a": {"type": "string", "description": "IFC class or category to check, e.g. IfcColumn or Walls."},
                    "selector_b": {
                        "type": "string",
                        "description": "Optional: second IFC class/category to check selector_a against. Omit to check selector_a against itself.",
                    },
                    "mode": {
                        "type": "string", "enum": ["collision", "intersection", "clearance"],
                        "description": "Clash mode (default collision).",
                    },
                    "clearance": {"type": "number", "description": "Required minimum clearance in meters, only for mode=clearance."},
                },
                "required": ["selector_a"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_ids_specs",
            "description": (
                "List IDS (buildingSMART Information Delivery Specification) compliance specs "
                "already uploaded for this model, via the IDS Check panel. Use before "
                "check_ids_compliance to find a spec_id."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_ids_compliance",
            "description": (
                "Run an IDS compliance check against a previously uploaded spec and report pass/"
                "fail per requirement. Use when the user asks to 'check IDS compliance' or "
                "'validate against the spec'. Find spec_id via list_ids_specs first if not already "
                "known. Can take up to a minute or more for a large model."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "spec_id": {"type": "string", "description": "The IDS spec id to check against (see list_ids_specs)."},
                },
                "required": ["spec_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": (
                "List CDE (Common Data Environment) documents for this project — drawings, specs, "
                "and other files with their WIP/Shared/Published/Archived status and approval "
                "gates. Use when the user asks 'what documents are there', 'is X approved', or "
                "'what's in WIP'. Read-only — approving/moving documents happens in the Documents "
                "panel, not here."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string", "enum": ["WIP", "Shared", "Published", "Archived"],
                        "description": "Optional: filter by status.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_document_status",
            "description": "Get full status/approval-gate detail and audit history for one document by filename.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Document filename or partial match."},
                },
                "required": ["filename"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_topics",
            "description": "List BCF coordination topics (issues) logged against this model.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_topic",
            "description": "Get full detail for one BCF topic by title (partial match) or guid.",
            "parameters": {
                "type": "object",
                "properties": {"reference": {"type": "string", "description": "Topic title (partial match) or guid."}},
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_topic",
            "description": (
                "Log a new BCF coordination topic (issue) on this model — e.g. to record a clash "
                "or QA finding as a trackable issue. Use after check_clashes/check_data_quality "
                "when the user wants to log what was found, or whenever they ask to 'create an "
                "issue' / 'log this'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "priority": {"type": "string", "description": "e.g. Low, Normal, High, Critical."},
                    "assigned_to": {"type": "string"},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_topic",
            "description": "Update a BCF topic's status, priority, or assignee. Only pass the fields to change.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {"type": "string", "description": "Topic title (partial match) or guid."},
                    "topic_status": {"type": "string", "description": "e.g. Open, In Progress, Closed."},
                    "priority": {"type": "string"},
                    "assigned_to": {"type": "string"},
                },
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_topic_comments",
            "description": "List all comments on a BCF topic.",
            "parameters": {
                "type": "object",
                "properties": {"reference": {"type": "string", "description": "Topic title (partial match) or guid."}},
                "required": ["reference"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_topic_comment",
            "description": "Add a comment to a BCF topic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reference": {"type": "string", "description": "Topic title (partial match) or guid."},
                    "comment": {"type": "string"},
                },
                "required": ["reference", "comment"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# LLM call — sync
# ---------------------------------------------------------------------------

def _get_url_and_headers(provider: str, api_key: str, base_url: str) -> tuple[str, dict]:
    if provider == "openai":
        return "https://api.openai.com/v1/chat/completions", {
            "Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
        }
    if provider == "mistral":
        return "https://api.mistral.ai/v1/chat/completions", {
            "Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
        }
    if provider == "ollama":
        return f"{base_url.rstrip('/')}/v1/chat/completions", {"Content-Type": "application/json"}
    # lmstudio
    return f"{base_url.rstrip('/')}/chat/completions", {"Content-Type": "application/json"}


def _post_with_retries(url: str, headers: dict, body: dict, timeout: int,
                        stream: bool = False, max_retries: int = 2):
    """POST with backoff on transient failures — connection errors/timeouts,
    429 rate limits, and 5xx server errors. Does NOT retry other 4xx errors
    (bad request, auth) since the same unchanged request would just fail the
    same way again. Previously a single requests.post() meant any transient
    network hiccup or provider rate limit surfaced straight to the user as a
    raw error instead of the agent quietly recovering."""
    resp = None
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(url, json=body, headers=headers, timeout=timeout, stream=stream)
        except requests.exceptions.RequestException:
            if attempt == max_retries:
                raise
            time.sleep(2 ** attempt)
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt < max_retries:
                time.sleep(2 ** attempt)
                continue
        return resp
    return resp  # pragma: no cover — loop always returns or raises above


def _call_llm(provider: str, model: str, api_key: str, base_url: str,
              messages: list, tools: list) -> dict:
    url, headers = _get_url_and_headers(provider, api_key, base_url)
    body = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.1,
        "max_tokens": 2048,
    }
    resp = _post_with_retries(url, headers, body, timeout=60)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# LLM call — streaming (item 9)
# Yields ('text_delta', str) or ('message', dict) events.
# The final 'message' event carries the fully assembled message for history.
# ---------------------------------------------------------------------------

def _call_llm_stream(provider: str, model: str, api_key: str, base_url: str,
                     messages: list, tools: list) -> Generator:
    url, headers = _get_url_and_headers(provider, api_key, base_url)
    body = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "temperature": 0.1,
        "max_tokens": 2048,
        "stream": True,
    }
    # Retries only cover establishing the connection/initial response — once
    # iter_lines() below starts yielding tokens to the frontend, a retry would
    # duplicate already-sent content, so there's no retry inside that loop.
    resp = _post_with_retries(url, headers, body, timeout=120, stream=True)
    resp.raise_for_status()

    # Accumulate tool_call argument chunks keyed by index
    tool_calls_acc: dict[int, dict] = {}
    full_content = ""

    for raw_line in resp.iter_lines():
        if not raw_line:
            continue
        # raw_line may be bytes or str depending on requests version
        line = raw_line.decode() if isinstance(raw_line, bytes) else raw_line
        if not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload.strip() == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        choice = (chunk.get("choices") or [{}])[0]
        delta = choice.get("delta", {})

        if delta.get("content"):
            full_content += delta["content"]
            yield ("text_delta", delta["content"])

        for tc_chunk in delta.get("tool_calls") or []:
            idx = tc_chunk.get("index", 0)
            if idx not in tool_calls_acc:
                tool_calls_acc[idx] = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
            if tc_chunk.get("id"):
                tool_calls_acc[idx]["id"] = tc_chunk["id"]
            fn_chunk = tc_chunk.get("function", {})
            if fn_chunk.get("name"):
                tool_calls_acc[idx]["function"]["name"] += fn_chunk["name"]
            if fn_chunk.get("arguments"):
                tool_calls_acc[idx]["function"]["arguments"] += fn_chunk["arguments"]

    # Assemble the final message
    assembled_tcs = [tool_calls_acc[i] for i in sorted(tool_calls_acc)] if tool_calls_acc else []
    msg: dict = {"role": "assistant", "content": full_content or None}
    if assembled_tcs:
        msg["tool_calls"] = assembled_tcs
    yield ("message", msg)


# ---------------------------------------------------------------------------
# DB query helpers
# ---------------------------------------------------------------------------

def _query_elements(conn, model_id: str, category: str = None, ifc_class: str = None,
                    storey: str = None, name: str = None) -> list[str]:
    where = ["e.model_id = %s"]
    params: list = [model_id]
    if category:
        where.append("e.category ILIKE %s"); params.append(f"%{category}%")
    if ifc_class:
        where.append("e.ifc_class ILIKE %s"); params.append(f"%{ifc_class}%")
    if storey:
        where.append("e.storey ILIKE %s"); params.append(f"%{storey}%")
    if name:
        where.append("e.name ILIKE %s"); params.append(f"%{name}%")
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT speckle_id FROM bim_elements e WHERE {' AND '.join(where)} LIMIT 5000",
            params,
        )
        return [r[0] for r in cur.fetchall() if r[0]]


def _query_summary(conn, model_id: str, group_by: str) -> list[dict]:
    """
    Thin wrapper around db.query.get_quantity_takeoff() — reuses its
    GROUP BY/SUM/JOIN query instead of a second, independent copy of the
    same SQL. Re-shaped here (label/count field names, count-desc ordering,
    2-decimal rounding, top-50 cap) to preserve this function's existing
    external contract exactly, since get_summary's tool response shape is
    part of the agent's established behavior.
    """
    field = group_by if group_by in ("category", "storey", "ifc_class") else "category"
    takeoff = get_quantity_takeoff(conn, model_id, field)
    rows = [
        {
            "label": r["group"],
            "count": r["element_count"],
            "volume_m3": round(float(r["volume_m3"] or 0), 2),
            "area_m2": round(float(r["area_m2"] or 0), 2),
        }
        for r in takeoff["rows"]
    ]
    rows.sort(key=lambda r: -r["count"])
    return rows[:50]


_COST_UNIT_FIELDS = {"m3": "volume_m3", "m2": "area_m2", "count": "count"}


def _apply_cost_rates(summary_rows: list[dict], rates: list[dict]) -> dict:
    """Match rate rules (case-insensitive substring on group label) against
    _query_summary() rows and price each group. Mirrors speckle_mcp.py's
    speckle_cost_estimate — kept as a separate in-process implementation
    (not a shared import) since the two tool ecosystems are intentionally
    decoupled; see the "keep them separate" decision for the chat agent vs
    the MCP server.
    """
    def _match(group_name: str):
        for r in rates:
            if r.get("match", "").lower() in (group_name or "").lower():
                return r
        return None

    priced, unmatched = [], []
    for row in summary_rows:
        group = row.get("label") or "Unknown"
        rule = _match(group)
        if not rule:
            unmatched.append(group)
            continue
        unit = rule.get("unit", "count")
        rate = float(rule.get("rate", 0))
        qty = float(row.get(_COST_UNIT_FIELDS.get(unit, "count"), 0) or 0)
        # Each matched rule carries its own currency rather than assuming one
        # global currency — otherwise mixed-currency rate cards would silently
        # sum incompatible units into one misleading total.
        currency = rule.get("currency", "")
        priced.append({
            "group": group, "unit": unit, "quantity": round(qty, 2),
            "rate": rate, "cost": round(qty * rate, 2), "currency": currency,
        })

    priced.sort(key=lambda r: -r["cost"])
    currencies = {r["currency"] for r in priced}
    if len(currencies) <= 1:
        totals = [{"currency": next(iter(currencies), ""), "total": round(sum(r["cost"] for r in priced), 2)}]
    else:
        totals = [
            {"currency": cur, "total": round(sum(r["cost"] for r in priced if r["currency"] == cur), 2)}
            for cur in sorted(currencies, key=lambda c: c or "")
        ]

    return {"priced": priced, "totals": totals, "unmatched_groups": unmatched}


def _query_by_parameter(conn, model_id: str, key: str, value: str,
                         op: str = "contains",
                         category: str = None, storey: str = None) -> list[str]:
    """Find elements by parameter key/value with optional numeric comparison (item 6)."""
    where = ["e.model_id = %s", "p.key ILIKE %s"]
    params: list = [model_id, f"%{key}%"]

    _NUMERIC_OPS = {"gt": ">", "lt": "<", "gte": ">=", "lte": "<="}
    if op in _NUMERIC_OPS:
        try:
            numeric_val = float(value)
        except ValueError:
            # Invalid number — return empty rather than crash
            return []
        where.append(f"p.value_numeric {_NUMERIC_OPS[op]} %s")
        params.append(numeric_val)
    elif op == "eq":
        where.append("p.value = %s")
        params.append(value)
    else:  # contains (default)
        where.append("p.value ILIKE %s")
        params.append(f"%{value}%")

    if category:
        where.append("e.category ILIKE %s"); params.append(f"%{category}%")
    if storey:
        where.append("e.storey ILIKE %s"); params.append(f"%{storey}%")

    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT DISTINCT e.speckle_id
                FROM bim_elements e
                JOIN bim_parameters p ON p.element_id = e.element_id
                WHERE {' AND '.join(where)}
                LIMIT 5000""",
            params,
        )
        return [r[0] for r in cur.fetchall() if r[0]]


def _query_available_param_values(conn, model_id: str, key: str, limit: int = 10) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT DISTINCT p.value
               FROM bim_parameters p
               JOIN bim_elements e ON e.element_id = p.element_id
               WHERE e.model_id = %s AND p.key ILIKE %s AND p.value IS NOT NULL
               ORDER BY p.value LIMIT %s""",
            (model_id, f"%{key}%", limit),
        )
        return [r[0] for r in cur.fetchall()]


def _query_materials(conn, model_id: str, category: str = None) -> list[dict]:
    """
    Primary path: canonical_key='material' — the IFC-standard, source-agnostic
    name db/query.py's own material queries already treat as the primary
    signal (populated at ingest from mapping_canonical.json). Falls back to
    the raw 'material%'-prefixed key match only when canonical_key finds
    nothing, for models ingested before canonical_key existed — this used to
    be the *only* path here, independently re-deriving a weaker version of
    logic db/query.py's dashboard-facing queries already got right.
    """
    extra_where = ""
    params: list = [model_id]
    if category:
        extra_where = "AND e.category ILIKE %s"
        params.append(f"%{category}%")
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT p.value AS material,
                       COUNT(DISTINCT e.element_id) AS count,
                       ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3
                FROM bim_parameters p
                JOIN bim_elements e ON e.element_id = p.element_id
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s AND p.canonical_key = 'material' {extra_where}
                  AND p.value IS NOT NULL
                GROUP BY p.value
                ORDER BY count DESC
                LIMIT 30""",
            params,
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        if rows:
            return rows

        cur.execute(
            f"""SELECT p.value AS material,
                       COUNT(DISTINCT e.element_id) AS count,
                       ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3
                FROM bim_parameters p
                JOIN bim_elements e ON e.element_id = p.element_id
                LEFT JOIN bim_geometry g ON g.element_id = e.element_id
                WHERE e.model_id = %s AND p.key ILIKE 'material%%' {extra_where}
                  AND p.value IS NOT NULL
                GROUP BY p.value
                ORDER BY count DESC
                LIMIT 30""",
            params,
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _query_profiles(conn, model_id: str) -> list[dict]:
    """
    Primary path: canonical_key IN ('profile', 'grade') — same reasoning as
    _query_materials above. Falls back to the raw key-pattern match (profile/
    grade/section-ish key names) only when canonical_key finds nothing.

    Scoped to steel elements (via the same _steel_element_ids() the
    dashboard's own by_profile chart already uses) when material/grade data
    exists at all — this tool is documented as "structural profiles ... and
    steel grades", but without this scope canonical_key='profile' alone
    would sweep in unrelated matches too: one of profile's own canonical
    aliases is a bare "Name" key (correct for Tekla, where NAME genuinely
    means the profile designation), which on non-Tekla models can collide
    with any other element's unrelated "Name" parameter (duct/pipe size
    codes showed up this way on a real Revit model during testing).
    _steel_element_ids() returns None (not an empty set) when there's no
    material/grade data at all, so unfiltered models still fall back to
    showing whatever profile/grade values exist instead of an empty result.
    """
    with conn.cursor() as cur:
        steel_ids = _steel_element_ids(cur, model_id)
        scope_sql, scope_params = "", []
        if steel_ids is not None:
            scope_sql = "AND p.element_id = ANY(%s::uuid[])"
            scope_params = [list(steel_ids)]

        cur.execute(
            f"""SELECT p.key AS param, p.value AS value,
                      COUNT(DISTINCT e.element_id) AS count,
                      ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3
               FROM bim_parameters p
               JOIN bim_elements e ON e.element_id = p.element_id
               LEFT JOIN bim_geometry g ON g.element_id = e.element_id
               WHERE e.model_id = %s AND p.canonical_key IN ('profile', 'grade') {scope_sql}
                 AND p.value IS NOT NULL
               GROUP BY p.key, p.value
               ORDER BY count DESC
               LIMIT 40""",
            [model_id] + scope_params,
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        if rows:
            return rows

        cur.execute(
            f"""SELECT p.key AS param, p.value AS value,
                      COUNT(DISTINCT e.element_id) AS count,
                      ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3
               FROM bim_parameters p
               JOIN bim_elements e ON e.element_id = p.element_id
               LEFT JOIN bim_geometry g ON g.element_id = e.element_id
               WHERE e.model_id = %s
                 AND (p.key ILIKE '%%profile%%' OR p.key ILIKE '%%grade%%'
                      OR p.key ILIKE 'section%%' OR p.key = 'PROFILE'
                      OR p.key ILIKE '%%structural_section%%')
                 {scope_sql}
                 AND p.value IS NOT NULL
               GROUP BY p.key, p.value
               ORDER BY count DESC
               LIMIT 40""",
            [model_id] + scope_params,
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _query_model_changes(conn, model_id_current: str, model_id_baseline: str) -> dict:
    """
    Diff current model against a baseline — item 7. Thin wrapper around
    db.query.get_model_diff() (model_id_a=baseline, model_id_b=current in
    that function's own convention) instead of a second, independent copy
    of the added/removed/changed SQL also used by routers/analytics.py's
    /diff/{a}/{b} endpoint.
    """
    d = get_model_diff(conn, model_id_baseline, model_id_current)
    added = d["added"]

    added_by_cat = Counter((r.get("category") or "Unknown") for r in added)
    added_ids = [r["speckle_id"] for r in added if r.get("speckle_id")]

    return {
        "added_count":      len(added),
        "removed_count":    len(d["removed"]),
        "changed_count":    len(d["changed"]),
        "added_by_category": dict(added_by_cat.most_common(10)),
        "added_speckle_ids": added_ids[:500],
    }


def _run_async(coro):
    """Run an async coroutine to completion from this file's synchronous tool
    code, safely whether or not the calling thread already has a running
    event loop. run_chat_agent runs inside asyncio.to_thread's worker thread
    (no loop of its own — plain asyncio.run() would be fine there), but
    stream_chat_agent's generator is iterated directly on the FastAPI
    event-loop thread (routers/chat.py's SSE generator has no to_thread
    wrapper) — asyncio.run() would raise "cannot be called from a running
    event loop" there. Always spinning a dedicated thread sidesteps the
    difference entirely."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


async def _resolve_and_check_clashes(model_id: str, rule: dict) -> tuple[list[dict], str]:
    from routers.ifc_export import resolve_model_ifc_bytes
    from clash_check import run_clash_checks
    from process_pool import run_cpu_bound

    ifc_bytes, ifc_source = await resolve_model_ifc_bytes(model_id, None, None, "mm")
    results = await run_cpu_bound(run_clash_checks, ifc_bytes, [rule], ifc_source == "synthetic_export")
    return results, ifc_source


async def _resolve_and_check_ids(model_id: str, ids_content: str) -> tuple[dict, str]:
    from routers.ifc_export import resolve_model_ifc_bytes
    from ids_check import run_ids_check
    from process_pool import run_cpu_bound

    ifc_bytes, ifc_source = await resolve_model_ifc_bytes(model_id, None, None, "mm")
    report = await run_cpu_bound(run_ids_check, ifc_bytes, ids_content, ifc_source == "synthetic_export")
    return report, ifc_source


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _resolve_topic(conn, model_id: str, reference: str) -> dict | None:
    """Resolve a BCF topic by guid or partial title match — same 'reference'
    convention as get_element_details/find_nearby_elements above. guid is a
    native UUID column, so only query it when reference actually parses as
    one — Postgres raises a hard type error (not just 'no rows') for
    invalid UUID syntax, which would otherwise crash on the overwhelmingly
    common case of a caller passing a title instead of a guid."""
    with conn.cursor() as cur:
        if _is_uuid(reference):
            cur.execute("SELECT * FROM bcf_topics WHERE model_id = %s AND guid = %s", (model_id, reference))
            cols = [d[0] for d in cur.description]
            row = cur.fetchone()
            if row:
                return dict(zip(cols, row))
        cur.execute(
            "SELECT * FROM bcf_topics WHERE model_id = %s AND title ILIKE %s ORDER BY creation_date DESC LIMIT 1",
            (model_id, f"%{reference}%"),
        )
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None


def _create_topic_row(
    conn, model_id: str, stream_id: str | None, title: str, description=None,
    priority=None, assigned_to=None, creation_author: str = "AI Assistant",
) -> dict:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT pg_advisory_xact_lock(hashtext(%s));
                INSERT INTO bcf_topics
                    (model_id, stream_id, title, description, priority, assigned_to, creation_author, creation_date, "index")
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, NOW(),
                    COALESCE((SELECT MAX("index") FROM bcf_topics WHERE model_id = %s), 0) + 1
                )
                RETURNING guid, title, topic_status, priority
                """,
                (model_id, model_id, stream_id, title, description, priority, assigned_to, creation_author, model_id),
            )
            cols = [d[0] for d in cur.description]
            row = cur.fetchone()
        conn.commit()
        return dict(zip(cols, row))
    except Exception:
        conn.rollback()
        raise


def _update_topic_row(conn, topic_guid: str, fields: dict) -> dict:
    try:
        set_clause = ", ".join(f"{k} = %s" for k in fields)
        with conn.cursor() as cur:
            cur.execute(
                f"""UPDATE bcf_topics SET {set_clause}, modified_author = %s, modified_date = NOW()
                    WHERE guid = %s RETURNING guid, title, topic_status, priority""",
                (*fields.values(), "AI Assistant", topic_guid),
            )
            cols = [d[0] for d in cur.description]
            row = cur.fetchone()
        conn.commit()
        return dict(zip(cols, row))
    except Exception:
        conn.rollback()
        raise


def _add_comment_row(conn, topic_guid: str, comment: str, author: str = "AI Assistant") -> None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO bcf_comments (topic_guid, comment, author, date) VALUES (%s, %s, %s, NOW())",
                (topic_guid, comment, author),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------------------
# Shared tool executor (keeps run_ and stream_ in sync)
# Returns (tool_result_str, new_element_ids_or_None)
# ---------------------------------------------------------------------------

def _execute_tool(conn, model_id: str, fn: str, args: dict) -> tuple[str, list[str] | None]:
    """Thin safety-net wrapper around _execute_tool_impl: any unhandled
    exception (a bad query, a write that half-completed, ...) must roll the
    connection back before returning — otherwise release_conn() (called by
    routers/chat.py's finally block) hands a poisoned aborted-transaction
    connection back to the shared pool, breaking the *next* unrelated
    request that happens to draw it."""
    try:
        return _execute_tool_impl(conn, model_id, fn, args)
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        logger.error("Tool %s failed: %s", fn, exc, exc_info=True)
        return f"Tool '{fn}' failed: {exc}", None


def _execute_tool_impl(conn, model_id: str, fn: str, args: dict) -> tuple[str, list[str] | None]:
    if fn == "filter_elements":
        ids = _query_elements(conn, model_id, **{k: v for k, v in args.items()
                                                  if k in ("category", "ifc_class", "storey", "name")})
        if len(ids) == 0:
            cat_summary = _query_summary(conn, model_id, "category")
            available = ", ".join(r["label"] for r in cat_summary[:8] if r.get("label"))
            result = (
                f"No elements matched {args}. "
                f"Available categories: {available}. "
                "Try broadening the filter or use get_summary to see what's available."
            )
        else:
            result = f"Found {len(ids)} matching elements."
        return result, ids

    if fn == "get_summary":
        rows = _query_summary(conn, model_id, args.get("group_by", "category"))
        return _jdump(rows), None

    if fn == "query_by_parameter":
        ids = _query_by_parameter(
            conn, model_id,
            key=args.get("key", ""),
            value=args.get("value", ""),
            op=args.get("op", "contains"),
            category=args.get("category"),
            storey=args.get("storey"),
        )
        if len(ids) == 0:
            available_vals = _query_available_param_values(conn, model_id, args.get("key", ""))
            if available_vals:
                result = (
                    f"No elements matched '{args.get('value')}' for key '{args.get('key')}'. "
                    f"Available values: {', '.join(available_vals)}."
                )
            else:
                result = (
                    f"No elements matched and no values found for key '{args.get('key')}'. "
                    "Check Available Parameter Keys in the system context."
                )
        else:
            result = f"Found {len(ids)} elements where '{args.get('key')}' matches '{args.get('value')}'."
        return result, ids

    if fn == "get_materials":
        rows = _query_materials(conn, model_id, category=args.get("category"))
        if rows:
            return _jdump(rows), None
        return (
            "No material data found. Materials may not be stored under a 'material' key — "
            "use query_by_parameter with relevant keys from Available Parameter Keys.", None
        )

    if fn == "get_profiles":
        rows = _query_profiles(conn, model_id)
        if rows:
            return _jdump(rows), None
        return (
            "No profile or grade data found. Check Available Parameter Keys "
            "for steel-related keys.", None
        )

    if fn == "estimate_cost":
        rates = args.get("rates") or []
        if not rates:
            return "estimate_cost requires at least one rate rule in 'rates'.", None
        rows = _query_summary(conn, model_id, args.get("group_by", "category"))
        if not rows:
            return "No quantity data available for this model.", None
        return _jdump(_apply_cost_rates(rows, rates)), None

    if fn == "get_model_changes":
        baseline = args.get("compared_to", "")
        if not baseline:
            return "compared_to model_id is required.", None
        try:
            diff = _query_model_changes(conn, model_id, baseline)
        except Exception as exc:
            return f"Diff failed: {exc}", None
        added_ids = diff.pop("added_speckle_ids", [])
        result = _jdump(diff)
        return result, (added_ids if added_ids else None)

    if fn == "check_data_quality":
        report = get_model_qa(conn, model_id)
        return _jdump(report), None

    if fn == "get_parameter_completeness":
        report = get_parameter_completeness(
            conn, model_id,
            category=args.get("category"),
            ifc_class=args.get("ifc_class"),
            min_coverage=args.get("min_coverage", 0.0),
        )
        report["parameters"] = report["parameters"][:20]
        return _jdump(report), None

    if fn == "get_version_history":
        stream_id = get_model_stream_id(conn, model_id)
        if not stream_id:
            return "Could not determine the stream for this model.", None
        versions = get_model_trend(conn, stream_id)
        for v in versions:
            top_cats = [k for k, _ in sorted(v["by_category"].items(), key=lambda kv: kv[1], reverse=True)[:8]]
            v["by_category"] = {k: v["by_category"][k] for k in top_cats}
            v["volume_by_category"] = {k: v["volume_by_category"].get(k, 0) for k in top_cats}
        return _jdump(versions), None

    if fn == "find_nearby_elements":
        reference = args.get("reference", "")
        radius_m = args.get("radius_m")
        if not reference or radius_m is None:
            return "Both 'reference' and 'radius_m' are required.", None
        try:
            matches = find_nearby_elements(
                conn, model_id,
                origin=reference,
                radius_m=float(radius_m),
                category=args.get("category"),
            )
        except Exception as exc:
            return f"Nearby search failed: {exc}", None
        if not matches:
            return (
                f"No elements found within {radius_m}m of '{reference}'. "
                "Note: proximity search only works for elements ingested with SI "
                "geometry data — try re-ingesting this model if it predates this feature.", None
            )
        ids = [m["speckle_id"] for m in matches if m.get("speckle_id")]
        return _jdump(matches[:100]), ids

    if fn == "get_qa_elements":
        issue = args.get("issue", "")
        valid_issues = {"unclassified", "no_geometry", "no_name", "no_storey", "no_material", "duplicate_ids"}
        if issue not in valid_issues:
            return f"'issue' must be one of: {', '.join(sorted(valid_issues))}.", None
        elements = get_qa_elements(conn, model_id, issue, limit=int(args.get("limit") or 50))
        if not elements:
            return f"No elements found with issue '{issue}'.", None
        ids = [e["speckle_id"] for e in elements if e.get("speckle_id")]
        return _jdump(elements), ids

    if fn == "get_element_details":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        element = get_element_details(conn, model_id, reference)
        if not element:
            return f"No element found matching '{reference}'.", None
        ids = [element["speckle_id"]] if element.get("speckle_id") else None
        return _jdump(element), ids

    if fn == "get_related_elements":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        element = get_element_details(conn, model_id, reference)
        if not element:
            return f"No element found matching '{reference}'.", None
        rels = get_element_relationships(conn, element["element_id"])
        if not rels:
            return (
                f"No relationships found for '{reference}'. This only reflects parent/room/space "
                "references captured at ingest time — this model may not have that data, or the "
                "referenced elements (e.g. Rooms) may not have been ingested.", None,
            )
        ids = [r["speckle_id"] for r in rels if r.get("speckle_id")]
        return _jdump(rels), (ids or None)

    if fn == "get_connectivity":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        element = get_element_details(conn, model_id, reference)
        if not element:
            return f"No element found matching '{reference}'.", None
        hops = args.get("hops") or 2
        graph = get_element_connectivity(conn, model_id, element["element_id"], hops=int(hops))
        if len(graph["nodes"]) <= 1:
            return f"No connections found for '{reference}' within {hops} hop(s).", None
        ids = [n["speckle_id"] for n in graph["nodes"] if n.get("speckle_id")]
        return _jdump(graph), (ids or None)

    if fn == "semantic_search":
        query = args.get("query", "")
        if not query:
            return "'query' is required.", None
        try:
            matches = semantic_search_elements(conn, model_id, query, limit=int(args.get("limit") or 10))
        except Exception as exc:
            return f"Semantic search failed: {exc}", None
        if not matches:
            return (
                "No embeddings found for this model — semantic search requires it to have been "
                "ingested after this feature existed. Try query_by_parameter or filter_elements "
                "instead, or re-ingest this model to build embeddings.", None
            )
        ids = [m["speckle_id"] for m in matches if m.get("speckle_id")]
        return _jdump(matches), ids

    if fn == "check_clashes":
        selector_a = args.get("selector_a", "")
        if not selector_a:
            return "'selector_a' is required.", None
        rule = {
            "name": f"{selector_a} vs {args.get('selector_b') or selector_a}",
            "selector_a": selector_a,
            "mode": args.get("mode", "collision"),
        }
        if args.get("selector_b"):
            rule["selector_b"] = args["selector_b"]
        if args.get("clearance") is not None:
            rule["clearance"] = args["clearance"]
        try:
            results, ifc_source = _run_async(_resolve_and_check_clashes(model_id, rule))
        except Exception as exc:
            return f"Clash check failed: {exc}", None

        r = results[0] if results else {"count": 0, "clashes": []}
        count = r.get("count", 0)
        ids = None
        if count and ifc_source == "synthetic_export":
            app_ids = list({c.get("a_global_id") for c in r["clashes"]} | {c.get("b_global_id") for c in r["clashes"]})
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT speckle_id FROM bim_elements WHERE model_id = %s AND application_id = ANY(%s)",
                    (model_id, app_ids),
                )
                ids = [row[0] for row in cur.fetchall() if row[0]]
        result = f"Clash check ({rule['name']}, mode={rule['mode']}): {count} clash(es) found."
        if count and ifc_source != "synthetic_export":
            result += (
                " (3D highlighting unavailable — this check ran against the model's original IFC "
                "file, which has no Speckle-ID mapping.)"
            )
        return result, ids

    if fn == "list_ids_specs":
        with conn.cursor() as cur:
            cur.execute(
                "SELECT spec_id, filename, uploaded_at FROM bim_ids_specs WHERE model_id = %s ORDER BY uploaded_at DESC",
                (model_id,),
            )
            specs = [
                {"spec_id": str(r[0]), "filename": r[1], "uploaded_at": r[2].isoformat()}
                for r in cur.fetchall()
            ]
        if not specs:
            return "No IDS specs uploaded for this model yet — upload one via the IDS Check panel first.", None
        return _jdump(specs), None

    if fn == "check_ids_compliance":
        spec_id = args.get("spec_id", "")
        if not spec_id:
            return "'spec_id' is required — use list_ids_specs first.", None
        with conn.cursor() as cur:
            cur.execute(
                "SELECT content FROM bim_ids_specs WHERE model_id = %s AND spec_id = %s",
                (model_id, spec_id),
            )
            row = cur.fetchone()
        if not row:
            return f"IDS spec {spec_id} not found for this model.", None
        try:
            report, ifc_source = _run_async(_resolve_and_check_ids(model_id, row[0]))
        except Exception as exc:
            return f"IDS check failed: {exc}", None
        overall = "PASS" if report.get("status") else "FAIL"
        lines = [
            f"IDS check {overall} — {report.get('total_specifications_pass', 0)}/"
            f"{report.get('total_specifications', 0)} specifications passed "
            f"(checked against {ifc_source})."
        ]
        for spec in report.get("specifications", []):
            icon = "✓" if spec.get("status") else "✗"
            lines.append(
                f"  {icon} {spec.get('name', 'Unnamed')} "
                f"({spec.get('total_checks_pass', 0)}/{spec.get('total_checks', 0)} checks)"
            )
        return "\n".join(lines), None

    if fn == "list_documents":
        stream_id = get_model_stream_id(conn, model_id)
        if not stream_id:
            return "Could not determine the project for this model.", None
        from db.documents import list_documents as _list_docs
        docs = _list_docs(conn, stream_id, status=args.get("status"))
        if not docs:
            filt = f" with status={args['status']}" if args.get("status") else ""
            return f"No documents found{filt}.", None
        summary = [
            {
                "filename": d["filename"], "status": d["status"], "revision": d["revision"],
                "reviewed": d["reviewed"], "approved": d["approved"], "verified": d["verified"],
            }
            for d in docs
        ]
        return _jdump(summary), None

    if fn == "get_document_status":
        filename = args.get("filename", "")
        if not filename:
            return "'filename' is required.", None
        stream_id = get_model_stream_id(conn, model_id)
        if not stream_id:
            return "Could not determine the project for this model.", None
        from db.documents import list_documents as _list_docs, list_events
        docs = _list_docs(conn, stream_id)
        match = next((d for d in docs if filename.lower() in d["filename"].lower()), None)
        if not match:
            return f"No document matching '{filename}' found.", None
        match["events"] = list_events(conn, match["doc_id"])
        return _jdump(match), None

    if fn == "list_topics":
        with conn.cursor() as cur:
            cur.execute(
                "SELECT guid, title, topic_status, priority, assigned_to, due_date "
                "FROM bcf_topics WHERE model_id = %s ORDER BY creation_date DESC",
                (model_id,),
            )
            cols = [d[0] for d in cur.description]
            topics = [dict(zip(cols, r)) for r in cur.fetchall()]
        if not topics:
            return "No BCF topics logged for this model yet.", None
        return _jdump(topics), None

    if fn == "get_topic":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        topic = _resolve_topic(conn, model_id, reference)
        if not topic:
            return f"No topic matching '{reference}' found.", None
        return _jdump(topic), None

    if fn == "create_topic":
        title = args.get("title", "")
        if not title:
            return "'title' is required.", None
        stream_id = get_model_stream_id(conn, model_id)
        try:
            topic = _create_topic_row(
                conn, model_id, stream_id, title,
                description=args.get("description"), priority=args.get("priority"),
                assigned_to=args.get("assigned_to"),
            )
        except Exception as exc:
            return f"Could not create topic: {exc}", None
        return f"Created topic '{topic['title']}' (guid={topic['guid']}).", None

    if fn == "update_topic":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        topic = _resolve_topic(conn, model_id, reference)
        if not topic:
            return f"No topic matching '{reference}' found.", None
        fields = {k: args[k] for k in ("topic_status", "priority", "assigned_to") if args.get(k)}
        if not fields:
            return "No fields provided to update.", None
        try:
            updated = _update_topic_row(conn, topic["guid"], fields)
        except Exception as exc:
            return f"Could not update topic: {exc}", None
        return f"Updated topic '{updated['title']}': status={updated['topic_status']} priority={updated['priority']}", None

    if fn == "list_topic_comments":
        reference = args.get("reference", "")
        if not reference:
            return "'reference' is required.", None
        topic = _resolve_topic(conn, model_id, reference)
        if not topic:
            return f"No topic matching '{reference}' found.", None
        with conn.cursor() as cur:
            cur.execute(
                "SELECT author, comment, date FROM bcf_comments WHERE topic_guid = %s ORDER BY date",
                (topic["guid"],),
            )
            cols = [d[0] for d in cur.description]
            comments = [dict(zip(cols, r)) for r in cur.fetchall()]
        if not comments:
            return "No comments on this topic yet.", None
        return _jdump(comments), None

    if fn == "add_topic_comment":
        reference = args.get("reference", "")
        comment = args.get("comment", "")
        if not reference or not comment:
            return "Both 'reference' and 'comment' are required.", None
        topic = _resolve_topic(conn, model_id, reference)
        if not topic:
            return f"No topic matching '{reference}' found.", None
        try:
            _add_comment_row(conn, topic["guid"], comment)
        except Exception as exc:
            return f"Could not add comment: {exc}", None
        return f"Comment added to '{topic['title']}'.", None

    return "Unknown tool.", None


# ---------------------------------------------------------------------------
# System prompt builder — enriched with DB context + CoT guidance (items 2 & 5)
# ---------------------------------------------------------------------------

def _build_system_prompt(conn, model_id: str, model_context: dict | None) -> str:
    from psycopg2.extras import RealDictCursor

    def _fetch(cur, sql, params=()):
        """Execute and fetchall with safe fallback."""
        try:
            cur.execute(sql, params)
            return cur.fetchall()
        except Exception as exc:
            logger.warning("_build_system_prompt query failed: %s", exc)
            return []

    source = "Unknown"
    cat_rows = []
    storeys = []
    ifc_classes = []
    materials = []
    profiles = []
    param_keys = []

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        rows = _fetch(cur, "SELECT source FROM bim_models WHERE model_id = %s", (model_id,))
        source = (rows[0].get("source") or "Unknown") if rows else "Unknown"

        cat_rows = _fetch(cur,
            """SELECT e.category,
                      COUNT(*)                                                 AS cnt,
                      ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 1)        AS vol
               FROM bim_elements e
               LEFT JOIN bim_geometry g ON g.element_id = e.element_id
               WHERE e.model_id = %s
               GROUP BY e.category ORDER BY cnt DESC LIMIT 30""",
            (model_id,),
        )

        storeys = [
            r.get("storey") or ""
            for r in _fetch(cur,
                "SELECT DISTINCT storey FROM bim_elements"
                " WHERE model_id = %s AND storey IS NOT NULL ORDER BY storey LIMIT 30",
                (model_id,),
            )
            if r.get("storey")
        ]

        ifc_classes = [
            r.get("ifc_class") or ""
            for r in _fetch(cur,
                "SELECT ifc_class, COUNT(*) AS cnt FROM bim_elements"
                " WHERE model_id = %s AND ifc_class IS NOT NULL"
                " GROUP BY ifc_class ORDER BY cnt DESC LIMIT 20",
                (model_id,),
            )
            if r.get("ifc_class")
        ]

        materials = [
            r.get("value") or ""
            for r in _fetch(cur,
                """SELECT DISTINCT p.value FROM bim_parameters p
                   JOIN bim_elements e ON e.element_id = p.element_id
                   WHERE e.model_id = %s AND p.key ILIKE 'material%%' AND p.value IS NOT NULL
                   ORDER BY p.value LIMIT 20""",
                (model_id,),
            )
            if r.get("value")
        ]

        profiles = [
            r.get("value") or ""
            for r in _fetch(cur,
                """SELECT DISTINCT p.value FROM bim_parameters p
                   JOIN bim_elements e ON e.element_id = p.element_id
                   WHERE e.model_id = %s
                     AND (p.key ILIKE '%%profile%%' OR p.key ILIKE '%%grade%%'
                          OR p.key ILIKE 'section%%')
                     AND p.value IS NOT NULL
                   ORDER BY p.value LIMIT 20""",
                (model_id,),
            )
            if r.get("value")
        ]

        param_keys = [
            r.get("key") or ""
            for r in _fetch(cur,
                """SELECT DISTINCT p.key FROM bim_parameters p
                   JOIN bim_elements e ON e.element_id = p.element_id
                   WHERE e.model_id = %s ORDER BY p.key LIMIT 40""",
                (model_id,),
            )
            if r.get("key")
        ]

    total = sum(int(r.get("cnt") or 0) for r in cat_rows)
    cat_lines = "\n".join(
        f"  {r.get('category') or 'Unknown'}: {r.get('cnt', 0)} elements,"
        f" {r.get('vol') or 0} m³"
        for r in cat_rows
    )

    prompt = (
        f"You are a BIM Intelligence Assistant for a {source} model with {total} elements.\n\n"
        f"## Element Categories\n{cat_lines}\n"
    )
    if storeys:
        prompt += f"\n## Storeys / Levels\n{', '.join(storeys)}\n"
    if ifc_classes:
        prompt += f"\n## IFC Classes\n{', '.join(ifc_classes)}\n"
    if materials:
        prompt += f"\n## Materials\n{', '.join(materials)}\n"
    if profiles:
        prompt += f"\n## Profiles / Grades\n{', '.join(profiles)}\n"
    if param_keys:
        prompt += f"\n## Available Parameter Keys\n{', '.join(param_keys[:30])}\n"

    if model_context:
        for label, key in [("Families", "families"), ("Construction Phases", "phases"), ("Worksets", "worksets")]:
            vals = model_context.get(key)
            if vals:
                prompt += f"\n## {label}\n{', '.join(str(v) for v in vals[:20])}\n"

        sel = model_context.get("selectedElement")
        if sel and (sel.get("speckleId") or sel.get("name")):
            prompt += (
                f"\n## Currently Selected Element (in the 3D viewer)\n"
                f"Name: {sel.get('name') or 'Unnamed'}, Speckle ID: {sel.get('speckleId') or 'unknown'}, "
                f"Category: {sel.get('category') or 'unknown'}\n"
                "When the user refers to \"the selected element/object\", \"this element\", \"it\", or "
                "similar, use this Speckle ID as the `reference` argument for tools like find_nearby_elements.\n"
            )

    prompt += (
        "\n## Tools Available\n"
        "- filter_elements: highlight elements by category, ifc_class, storey, name\n"
        "- get_summary: aggregate counts/volumes grouped by category, storey, or ifc_class\n"
        "- query_by_parameter: find elements by any parameter key/value; supports numeric ops (gt/lt/gte/lte)\n"
        "- get_materials: list all materials with element counts and volumes\n"
        "- get_profiles: list structural profiles and steel grades\n"
        "- estimate_cost: apply user-supplied unit rates to quantities for a rough cost/budget estimate\n"
        "- get_model_changes: diff current model against another version (show added/removed/changed)\n"
        "- check_data_quality: BIM QA score + issues (missing names/storeys/materials/geometry, duplicates)\n"
        "- get_parameter_completeness: fill-rate % per parameter, worst-covered first\n"
        "- get_version_history: element-count/volume/area trend (overall + per category) across all ingested versions of this model\n"
        "- find_nearby_elements: find elements within a radius (meters) of a reference element or coordinate\n"
        "- get_related_elements: parent/room/space relationships (host wall, room contents, etc.) for an element\n"
        "- get_connectivity: multi-hop connectivity graph for an element — structural/IFC relationships plus "
        "physical touching, e.g. 'trace this duct run' or 'what's connected to this beam'\n"
        "- get_qa_elements: drill into a specific data-quality issue and highlight the affected elements\n"
        "- get_element_details: full details (geometry, all parameters) for one specific element\n"
        "- semantic_search: find elements by meaning/description rather than exact text match\n"
        "- check_clashes: geometric clash detection between two categories/IFC classes (can be slow)\n"
        "- list_ids_specs / check_ids_compliance: buildingSMART IDS spec compliance checking (can be slow)\n"
        "- list_documents / get_document_status: CDE document status and approval gates (read-only)\n"
        "- list_topics / get_topic / create_topic / update_topic / list_topic_comments / add_topic_comment: "
        "BCF coordination issues — log/track/discuss findings as trackable topics\n\n"
        "## Reasoning Guidance\n"
        "Before calling tools, briefly state your plan in one sentence (e.g. 'I'll filter beams by "
        "storey then get their volume.'). For multi-step queries, chain tools — each result informs the next. "
        "If a filter returns 0 results, use the fallback information to suggest alternatives.\n"
        "Keep answers concise. Report element counts after every filter."
    )
    return prompt


# ---------------------------------------------------------------------------
# Sync agentic loop (unchanged API — item 5 integrated via prompt + reasoning capture)
# ---------------------------------------------------------------------------

def run_chat_agent(
    conn,
    model_id: str,
    message: str,
    history: list,
    provider: str,
    api_key: str,
    model_name: str,
    base_url: str,
    model_context: dict | None = None,
) -> dict:
    """Run the agentic chat loop. Returns {text, elementIds, toolsUsed}."""
    system_prompt = _build_system_prompt(conn, model_id, model_context)

    messages = [{"role": "system", "content": system_prompt}]
    for h in (history or []):
        if h.get("role") in ("user", "assistant"):
            messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": message})

    tools_used: list[str] = []
    element_ids: list[str] = []
    reasoning_steps: list[str] = []

    for _ in range(MAX_TOOL_ROUNDS):
        result = _call_llm(provider, model_name, api_key, base_url, messages, _TOOLS)
        choice = result["choices"][0]
        msg = choice["message"]
        messages.append(msg)

        tool_calls = msg.get("tool_calls") or []

        # Capture intermediate reasoning text emitted alongside tool calls (item 5)
        if msg.get("content") and tool_calls:
            reasoning_steps.append(msg["content"])

        if not tool_calls:
            return {
                "text": msg.get("content") or "",
                "elementIds": element_ids,
                "toolsUsed": tools_used,
                "reasoning": reasoning_steps,
            }

        for tc in tool_calls:
            fn = tc["function"]["name"]
            args = json.loads(tc["function"]["arguments"] or "{}")
            tools_used.append(fn)
            tc_id = tc.get("id", fn)

            tool_result, new_ids = _execute_tool(conn, model_id, fn, args)
            if new_ids is not None:
                element_ids = new_ids

            messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})

    last_text = next(
        (m.get("content") for m in reversed(messages)
         if m.get("role") == "assistant" and m.get("content")),
        "I reached the response limit before finishing. Please try a more specific question.",
    )
    return {"text": last_text, "elementIds": element_ids, "toolsUsed": tools_used, "reasoning": reasoning_steps}


# ---------------------------------------------------------------------------
# Streaming agentic loop (item 9)
# Yields raw SSE-format strings: "data: {json}\n\n"
# ---------------------------------------------------------------------------

def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def stream_chat_agent(
    conn,
    model_id: str,
    message: str,
    history: list,
    provider: str,
    api_key: str,
    model_name: str,
    base_url: str,
    model_context: dict | None = None,
) -> Generator[str, None, None]:
    """
    Generator that runs the agentic loop and yields SSE events:
      {"type": "reasoning", "text": "..."}    — CoT reasoning before tool calls
      {"type": "tool_start", "name": "..."}   — tool beginning
      {"type": "tool_done", "name": "...", "count": int|null}
      {"type": "text_delta", "delta": "..."}  — streamed LLM text token
      {"type": "elements", "ids": [...]}       — final highlighted element IDs
      {"type": "done", "toolsUsed": [...]}     — all done
    """
    system_prompt = _build_system_prompt(conn, model_id, model_context)

    messages = [{"role": "system", "content": system_prompt}]
    for h in (history or []):
        if h.get("role") in ("user", "assistant"):
            messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": message})

    tools_used: list[str] = []
    element_ids: list[str] = []

    for _ in range(MAX_TOOL_ROUNDS):
        msg = None
        for event_type, event_data in _call_llm_stream(provider, model_name, api_key, base_url, messages, _TOOLS):
            if event_type == "text_delta":
                yield _sse({"type": "text_delta", "delta": event_data})
            elif event_type == "message":
                msg = event_data

        if msg is None:
            break

        messages.append(msg)
        tool_calls = msg.get("tool_calls") or []

        # Emit CoT reasoning text if present alongside tool calls
        if msg.get("content") and tool_calls:
            yield _sse({"type": "reasoning", "text": msg["content"]})

        if not tool_calls:
            # Final response — text was already streamed via text_delta events
            yield _sse({"type": "elements", "ids": element_ids})
            yield _sse({"type": "done", "toolsUsed": tools_used})
            return

        for tc in tool_calls:
            fn = tc["function"]["name"]
            args = json.loads(tc["function"]["arguments"] or "{}")
            tools_used.append(fn)
            tc_id = tc.get("id", fn)

            yield _sse({"type": "tool_start", "name": fn})

            tool_result, new_ids = _execute_tool(conn, model_id, fn, args)
            if new_ids is not None:
                element_ids = new_ids

            count = len(new_ids) if new_ids is not None else None
            yield _sse({"type": "tool_done", "name": fn, "count": count})

            messages.append({"role": "tool", "tool_call_id": tc_id, "content": tool_result})

    # Exhausted MAX_TOOL_ROUNDS without a final non-tool-call reply. Previously
    # this fell straight through to "elements"/"done" with no text_delta ever
    # sent — the frontend showed a blank assistant bubble with no explanation.
    yield _sse({"type": "text_delta", "delta": "I reached the response limit before finishing. Please try a more specific question."})
    yield _sse({"type": "elements", "ids": element_ids})
    yield _sse({"type": "done", "toolsUsed": tools_used})
