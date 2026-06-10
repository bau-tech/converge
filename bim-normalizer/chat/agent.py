"""
BIM Chat Agent — agentic loop with tool execution and SSE streaming.

Items implemented here:
 5. Chain-of-thought reasoning instruction + intermediate reasoning capture
 6. Typed numeric parameter comparisons (op: gt/lt/gte/lte/eq/contains)
 7. Model diff awareness via get_model_changes tool
 9. stream_chat_agent generator for SSE streaming
"""
import json
import logging
from collections import Counter
from typing import Generator

import requests

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
    resp = requests.post(url, json=body, headers=headers, timeout=60)
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
    resp = requests.post(url, json=body, headers=headers, stream=True, timeout=120)
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
    col_map = {"category": "e.category", "storey": "e.storey", "ifc_class": "e.ifc_class"}
    col = col_map.get(group_by, "e.category")
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT {col} AS label,
                   COUNT(*) AS count,
                   ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3,
                   ROUND(SUM(COALESCE(g.area_m2,   0))::numeric, 2) AS area_m2
            FROM bim_elements e
            LEFT JOIN bim_geometry g ON g.element_id = e.element_id
            WHERE e.model_id = %s
            GROUP BY {col}
            ORDER BY count DESC
            LIMIT 50
            """,
            (model_id,),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


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
                WHERE e.model_id = %s AND p.key ILIKE 'material%' {extra_where}
                  AND p.value IS NOT NULL
                GROUP BY p.value
                ORDER BY count DESC
                LIMIT 30""",
            params,
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _query_profiles(conn, model_id: str) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.key AS param, p.value AS value,
                      COUNT(DISTINCT e.element_id) AS count,
                      ROUND(SUM(COALESCE(g.volume_m3, 0))::numeric, 2) AS volume_m3
               FROM bim_parameters p
               JOIN bim_elements e ON e.element_id = p.element_id
               LEFT JOIN bim_geometry g ON g.element_id = e.element_id
               WHERE e.model_id = %s
                 AND (p.key ILIKE '%profile%' OR p.key ILIKE '%grade%'
                      OR p.key ILIKE 'section%' OR p.key = 'PROFILE'
                      OR p.key ILIKE '%structural_section%')
                 AND p.value IS NOT NULL
               GROUP BY p.key, p.value
               ORDER BY count DESC
               LIMIT 40""",
            (model_id,),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _query_model_changes(conn, model_id_current: str, model_id_baseline: str) -> dict:
    """Diff current model against a baseline — item 7."""
    with conn.cursor() as cur:
        # Added (in current, not in baseline)
        cur.execute(
            """SELECT b.speckle_id, b.category, b.name
               FROM bim_elements b
               WHERE b.model_id = %s
                 AND b.application_id IS NOT NULL AND b.application_id <> ''
                 AND NOT EXISTS (
                     SELECT 1 FROM bim_elements a
                     WHERE a.model_id = %s AND a.application_id = b.application_id
                 )""",
            (model_id_current, model_id_baseline),
        )
        added = cur.fetchall()

        # Removed count (in baseline, not in current)
        cur.execute(
            """SELECT COUNT(*) FROM bim_elements a
               WHERE a.model_id = %s
                 AND a.application_id IS NOT NULL AND a.application_id <> ''
                 AND NOT EXISTS (
                     SELECT 1 FROM bim_elements b
                     WHERE b.model_id = %s AND b.application_id = a.application_id
                 )""",
            (model_id_baseline, model_id_current),
        )
        _row = cur.fetchone()
        removed_count = int((_row[0] if _row else 0) or 0)

        # Changed (same app_id, different hash)
        cur.execute(
            """SELECT COUNT(*) FROM bim_elements a
               JOIN bim_elements b ON a.application_id = b.application_id
               WHERE a.model_id = %s AND b.model_id = %s
                 AND a.hash IS NOT NULL AND b.hash IS NOT NULL
                 AND a.hash <> b.hash""",
            (model_id_baseline, model_id_current),
        )
        _row = cur.fetchone()
        changed_count = int((_row[0] if _row else 0) or 0)

    added_by_cat = Counter(r[1] or "Unknown" for r in added)
    added_ids = [r[0] for r in added if r[0]]

    return {
        "added_count":      len(added),
        "removed_count":    removed_count,
        "changed_count":    changed_count,
        "added_by_category": dict(added_by_cat.most_common(10)),
        "added_speckle_ids": added_ids[:500],
    }


# ---------------------------------------------------------------------------
# Shared tool executor (keeps run_ and stream_ in sync)
# Returns (tool_result_str, new_element_ids_or_None)
# ---------------------------------------------------------------------------

def _execute_tool(conn, model_id: str, fn: str, args: dict) -> tuple[str, list[str] | None]:
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
        return json.dumps(rows), None

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
            return json.dumps(rows), None
        return (
            "No material data found. Materials may not be stored under a 'material' key — "
            "use query_by_parameter with relevant keys from Available Parameter Keys.", None
        )

    if fn == "get_profiles":
        rows = _query_profiles(conn, model_id)
        if rows:
            return json.dumps(rows), None
        return (
            "No profile or grade data found. Check Available Parameter Keys "
            "for steel-related keys.", None
        )

    if fn == "get_model_changes":
        baseline = args.get("compared_to", "")
        if not baseline:
            return "compared_to model_id is required.", None
        try:
            diff = _query_model_changes(conn, model_id, baseline)
        except Exception as exc:
            return f"Diff failed: {exc}", None
        added_ids = diff.pop("added_speckle_ids", [])
        result = json.dumps(diff)
        return result, (added_ids if added_ids else None)

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

    prompt += (
        "\n## Tools Available\n"
        "- filter_elements: highlight elements by category, ifc_class, storey, name\n"
        "- get_summary: aggregate counts/volumes grouped by category, storey, or ifc_class\n"
        "- query_by_parameter: find elements by any parameter key/value; supports numeric ops (gt/lt/gte/lte)\n"
        "- get_materials: list all materials with element counts and volumes\n"
        "- get_profiles: list structural profiles and steel grades\n"
        "- get_model_changes: diff current model against another version (show added/removed/changed)\n\n"
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

    for _ in range(5):  # extra round for CoT reasoning step
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

    for _ in range(5):
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

    yield _sse({"type": "elements", "ids": element_ids})
    yield _sse({"type": "done", "toolsUsed": tools_used})
