"""
Pure unit tests for the Anthropic Messages API converters in chat/agent.py —
no DB mocking needed, these are pure functions. Anthropic's wire shape
differs from every other (OpenAI-compatible) provider this file supports:
a top-level `system` field, `input_schema` tools, `content` blocks instead
of `choices[0].message`, and — the trickiest part — every tool_result for a
given assistant turn's tool_use blocks must be combined into a SINGLE
following user message, unlike OpenAI's one role:"tool" message per call.
"""
import json

from chat.agent import _TOOLS, _anthropic_response_to_canonical, _messages_to_anthropic, _to_anthropic_tools


def test_to_anthropic_tools_reshapes_schema():
    tools = [{
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Aggregate counts.",
            "parameters": {
                "type": "object",
                "properties": {"group_by": {"type": "string"}},
                "required": ["group_by"],
            },
        },
    }]

    assert _to_anthropic_tools(tools) == [{
        "name": "get_summary",
        "description": "Aggregate counts.",
        "input_schema": {
            "type": "object",
            "properties": {"group_by": {"type": "string"}},
            "required": ["group_by"],
        },
    }]


def test_to_anthropic_tools_handles_the_full_tool_list():
    result = _to_anthropic_tools(_TOOLS)

    assert len(result) == len(_TOOLS)
    names = {t["name"] for t in result}
    for expected in ("get_schedule", "get_element_tasks", "check_federated_clashes", "get_notifications"):
        assert expected in names
    for t in result:
        assert set(t.keys()) == {"name", "description", "input_schema"}


def test_messages_to_anthropic_extracts_system_and_plain_turn():
    messages = [
        {"role": "system", "content": "You are a BIM assistant."},
        {"role": "user", "content": "How many walls?"},
        {"role": "assistant", "content": "There are 12 walls."},
    ]

    system_prompt, anth_messages = _messages_to_anthropic(messages)

    assert system_prompt == "You are a BIM assistant."
    assert anth_messages == [
        {"role": "user", "content": "How many walls?"},
        {"role": "assistant", "content": "There are 12 walls."},
    ]


def test_messages_to_anthropic_assistant_tool_call_becomes_tool_use_block():
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "count walls"},
        {
            "role": "assistant",
            "content": "I'll check the summary.",
            "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "get_summary", "arguments": '{"group_by": "category"}'}},
            ],
        },
    ]

    _, anth_messages = _messages_to_anthropic(messages)

    assert anth_messages[-1] == {
        "role": "assistant",
        "content": [
            {"type": "text", "text": "I'll check the summary."},
            {"type": "tool_use", "id": "call_1", "name": "get_summary", "input": {"group_by": "category"}},
        ],
    }


def test_messages_to_anthropic_collapses_multiple_tool_results_into_one_message():
    """The structural requirement Anthropic imposes that OpenAI doesn't:
    two role:"tool" messages in the canonical list must become ONE user
    message with two tool_result blocks, not two separate user messages."""
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "compare walls and columns"},
        {
            "role": "assistant", "content": None,
            "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "get_summary", "arguments": "{}"}},
                {"id": "call_2", "type": "function", "function": {"name": "get_materials", "arguments": "{}"}},
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "12 walls"},
        {"role": "tool", "tool_call_id": "call_2", "content": "3 materials"},
        {"role": "assistant", "content": "Here's the comparison."},
    ]

    _, anth_messages = _messages_to_anthropic(messages)

    tool_result_messages = [
        m for m in anth_messages if m["role"] == "user" and isinstance(m["content"], list)
    ]
    assert len(tool_result_messages) == 1
    assert tool_result_messages[0]["content"] == [
        {"type": "tool_result", "tool_use_id": "call_1", "content": "12 walls"},
        {"type": "tool_result", "tool_use_id": "call_2", "content": "3 materials"},
    ]
    assert anth_messages[-1] == {"role": "assistant", "content": "Here's the comparison."}


def test_anthropic_response_to_canonical_text_only():
    data = {"content": [{"type": "text", "text": "There are 12 walls."}]}

    msg = _anthropic_response_to_canonical(data)

    assert msg == {"role": "assistant", "content": "There are 12 walls."}
    assert "tool_calls" not in msg


def test_anthropic_response_to_canonical_with_tool_use():
    data = {
        "content": [
            {"type": "text", "text": "I'll check."},
            {"type": "tool_use", "id": "toolu_1", "name": "get_summary", "input": {"group_by": "storey"}},
        ],
    }

    msg = _anthropic_response_to_canonical(data)

    assert msg["role"] == "assistant"
    assert msg["content"] == "I'll check."
    assert msg["tool_calls"] == [{
        "id": "toolu_1", "type": "function",
        "function": {"name": "get_summary", "arguments": json.dumps({"group_by": "storey"})},
    }]


def test_anthropic_response_to_canonical_no_text_content_is_none():
    data = {"content": [{"type": "tool_use", "id": "toolu_1", "name": "get_summary", "input": {}}]}

    msg = _anthropic_response_to_canonical(data)

    assert msg["content"] is None
