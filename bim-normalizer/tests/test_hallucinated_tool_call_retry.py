"""
Unit tests for chat/agent.py's retry-on-hallucinated-tool-call handling.

Regression coverage for a real bug found live on the Fumadocs docs site
(same @ai-sdk/groq + openai/gpt-oss-20b combination this app's own Groq
provider option uses): the model occasionally calls a tool name that was
never declared (observed: "open_page", "open_file" — likely bleed-through
from browsing-agent training data) or malforms a real tool's arguments.
Groq's own API rejects the *entire* chat-completion request with a 400
"Tool call validation failed" the moment this happens, before any
tool_calls ever reach this app's own dispatch logic (_execute_tool's
"Unknown tool." safety net, covered by test_unknown_tool in
test_chat_agent_dispatch.py, never gets a chance to run). Since the failure
comes from the model's own sampling rather than a deterministic problem
with the request body, retrying the exact same request can succeed.
"""
from types import SimpleNamespace
from unittest.mock import patch

from chat.agent import _is_hallucinated_tool_call_error, _post_with_retries


def _fake_response(status_code: int, json_body: dict | None = None):
    return SimpleNamespace(status_code=status_code, json=lambda: json_body or {})


def test_detects_tool_call_validation_failure():
    resp = _fake_response(400, {
        "error": {
            "message": "Tool call validation failed: tool call validation failed: "
                       "attempted to call tool 'open_page' which was not in request.tools",
            "type": "invalid_request_error",
        }
    })
    assert _is_hallucinated_tool_call_error(resp) is True


def test_other_400s_are_not_treated_as_retryable():
    resp = _fake_response(400, {
        "error": {"message": "Invalid API key provided", "type": "invalid_request_error"}
    })
    assert _is_hallucinated_tool_call_error(resp) is False


def test_non_400_status_is_never_retryable_via_this_check():
    resp = _fake_response(429, {"error": {"message": "rate limited"}})
    assert _is_hallucinated_tool_call_error(resp) is False


def test_unparseable_body_is_not_retryable():
    resp = SimpleNamespace(status_code=400, json=lambda: (_ for _ in ()).throw(ValueError("bad json")))
    assert _is_hallucinated_tool_call_error(resp) is False


def test_post_with_retries_retries_hallucinated_tool_call():
    bad = _fake_response(400, {
        "error": {"message": "Tool call validation failed: bad tool", "type": "invalid_request_error"}
    })
    good = _fake_response(200, {"choices": [{"message": {"role": "assistant", "content": "ok"}}]})
    with patch("chat.agent.requests.post", side_effect=[bad, good]) as mock_post, \
         patch("chat.agent.time.sleep"):  # skip real backoff delay
        resp = _post_with_retries("https://api.groq.com/openai/v1/chat/completions", {}, {}, timeout=60)

    assert resp is good
    assert mock_post.call_count == 2


def test_post_with_retries_gives_up_after_max_retries():
    bad = _fake_response(400, {
        "error": {"message": "Tool call validation failed: bad tool", "type": "invalid_request_error"}
    })
    with patch("chat.agent.requests.post", return_value=bad) as mock_post, \
         patch("chat.agent.time.sleep"):
        resp = _post_with_retries("https://api.groq.com/openai/v1/chat/completions", {}, {}, timeout=60, max_retries=2)

    assert resp is bad
    assert mock_post.call_count == 3  # initial attempt + 2 retries
