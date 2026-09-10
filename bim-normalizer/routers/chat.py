import asyncio
import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dashboard_auth.dependencies import CurrentUser, get_current_user_optional

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


def _friendly_error_message(exc: Exception) -> str:
    """Translate a raw provider-call exception into something a chat user can
    actually act on, instead of a dumped `HTTPError: 500 Server Error: ...`.
    The full exception/traceback is still logged server-side by callers —
    this only changes what reaches the chat UI.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status == 400 and response is not None:
        try:
            message = str((response.json() or {}).get("error", {}).get("message", ""))
        except (ValueError, AttributeError):
            message = ""
        if "tool call validation failed" in message.lower():
            return ("The AI model attempted an invalid action and the request failed, even after "
                    "automatic retries — a known reliability issue with some faster/smaller models. "
                    "Try asking again, or ask an admin to switch to a different model.")
    if status == 429:
        return ("The AI provider is rate-limiting requests right now (no quota left this minute). "
                "Wait a moment and try again, or ask an admin to check the provider account's plan/billing.")
    if status == 403:
        return ("The AI provider rejected this request — the configured model isn't available on the "
                "current subscription tier. Ask an admin to check the provider account's plan or pick a different model.")
    if status == 401:
        return "The AI provider rejected the API key. Ask an admin to check the configured API key."
    if status is not None and status >= 500:
        return "The AI provider is temporarily unavailable. Please try again in a moment."
    return f"{type(exc).__name__}: {exc}"


class ChatRequest(BaseModel):
    message: str
    model_id: str | None = None   # normalizer model UUID (bim_models.model_id)
    history: list = []
    ai_provider: str = "gemini"
    openai_config: dict | None = None
    ollama_config: dict | None = None
    lmstudio_config: dict | None = None
    mistral_config: dict | None = None
    anthropic_config: dict | None = None
    groq_config: dict | None = None
    gemini_config: dict | None = None
    model_context: dict | None = None  # optional frontend-supplied context (families, phases, worksets, etc.)


def _resolve_provider(request: ChatRequest) -> tuple[str, str, str, str]:
    """Returns (provider, api_key, model_name, base_url).

    OpenAI's model used to be hardcoded to gpt-4o-mini regardless of anything
    the frontend sent — unlike every other provider, which already accepted a
    model override via its own *_config dict. openai_config brings it in line;
    the default is unchanged so this doesn't silently change cost/behavior for
    existing callers that don't pass it.
    """
    provider = request.ai_provider
    if provider == "openai":
        cfg = request.openai_config or {}
        api_key = cfg.get("apiKey") or os.getenv("OPENAI_API_KEY", "")
        model_name = cfg.get("model", "gpt-4o-mini")
        base_url = ""
    elif provider == "mistral":
        cfg = request.mistral_config or {}
        api_key = cfg.get("apiKey") or os.getenv("MISTRAL_API_KEY", "")
        model_name = cfg.get("model", "mistral-small-latest")
        base_url = ""
    elif provider == "anthropic":
        cfg = request.anthropic_config or {}
        api_key = cfg.get("apiKey") or os.getenv("ANTHROPIC_API_KEY", "")
        model_name = cfg.get("model", "claude-sonnet-5")
        base_url = ""
    elif provider == "groq":
        cfg = request.groq_config or {}
        api_key = cfg.get("apiKey") or os.getenv("GROQ_API_KEY", "")
        # 20b over 120b: measured identical account-level free-tier TPM cap
        # (8000 tokens/min, flat across models on this account — NOT raised by
        # picking a smaller model) but 20b's reasoning is less verbose, using
        # somewhat fewer completion tokens per call. Doesn't fix the ceiling —
        # this app's 33-tool schema alone costs ~4300 prompt tokens per call,
        # and one chat turn needs 2 calls (tool decision + answer synthesis),
        # so ~8600+ tokens/turn structurally exceeds an 8000 TPM free tier
        # regardless of model. A real fix needs a paid Groq tier or trimming
        # the tools payload, not a different free-tier model.
        model_name = cfg.get("model", "openai/gpt-oss-20b")
        base_url = ""
    elif provider == "gemini":
        cfg = request.gemini_config or {}
        api_key = cfg.get("apiKey") or os.getenv("GEMINI_API_KEY", "")
        # Free-tier headroom checked live against this app's actual per-turn
        # cost (33-tool schema + 2 calls/turn, ~8600+ tokens — see groq's own
        # comment above for where that number comes from): Gemini's OpenAI-
        # compatible endpoint reports 250K-1M TPM on 2.5 Flash, ~30-100x this
        # app's requirement, unlike Groq's flat 8000 TPM cap that structurally
        # can't fit it regardless of model.
        model_name = cfg.get("model", "gemini-2.5-flash")
        base_url = ""
    elif provider == "ollama":
        cfg = request.ollama_config or {}
        # Empty by default (matches every other local-model provider here) —
        # but not hardcoded empty like before: pointing base_url at
        # https://ollama.com instead of a local address is Ollama Cloud (a
        # real hosted service, not self-hosted), which needs a Bearer token
        # the same way every hosted provider above does. Harmless to send an
        # empty string against a real local server — _get_url_and_headers
        # below only adds the header when this is non-empty.
        api_key = cfg.get("apiKey") or os.getenv("OLLAMA_API_KEY", "")
        model_name = cfg.get("model", "llama3")
        base_url = cfg.get("baseUrl", "http://localhost:11434")
    else:  # lmstudio
        cfg = request.lmstudio_config or {}
        api_key = ""
        model_name = cfg.get("model", "local-model")
        base_url = cfg.get("baseUrl", "http://localhost:1234/v1")
    return provider, api_key, model_name, base_url


@router.post("/chat")
async def chat(request: ChatRequest, user: CurrentUser | None = Depends(get_current_user_optional)):
    """
    Agentic chat endpoint. Calls the configured LLM with tools that can
    query the normalizer DB (filter elements, get summaries). Returns
    {text, elementIds, toolsUsed} so the frontend can highlight elements.

    Auth is optional (not required) — this endpoint intentionally also
    serves anonymous /shareXXX visitors (see App.jsx's auth-gate comment).
    `user` is None for those; tools that need real identity (notifications,
    org-scoped WIP document visibility) degrade gracefully rather than
    guessing when it's absent.
    """
    from chat.agent import run_chat_agent
    from db.connection import get_conn, release_conn

    if not request.model_id:
        raise HTTPException(status_code=400, detail="model_id is required")

    provider, api_key, model_name, base_url = _resolve_provider(request)

    conn = get_conn()
    try:
        result = await asyncio.to_thread(
            run_chat_agent,
            conn,
            request.model_id,
            request.message,
            request.history,
            provider,
            api_key,
            model_name,
            base_url,
            request.model_context,
            user,
        )
        return result
    except Exception as exc:
        logger.error("Chat agent error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=_friendly_error_message(exc))
    finally:
        release_conn(conn)


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest, user: CurrentUser | None = Depends(get_current_user_optional)):
    """
    SSE streaming variant of /chat. Yields events:
      data: {"type":"reasoning","text":"..."}
      data: {"type":"tool_start","name":"..."}
      data: {"type":"tool_done","name":"...","count":N}
      data: {"type":"text_delta","delta":"..."}
      data: {"type":"elements","ids":[...]}
      data: {"type":"done","toolsUsed":[...]}

    Auth is optional here too — see chat()'s docstring above.
    """
    import asyncio
    from chat.agent import stream_chat_agent
    from db.connection import get_conn, release_conn

    if not request.model_id:
        raise HTTPException(status_code=400, detail="model_id is required")

    provider, api_key, model_name, base_url = _resolve_provider(request)

    async def generator():
        conn = get_conn()
        try:
            for event in stream_chat_agent(
                conn,
                request.model_id,
                request.message,
                request.history,
                provider,
                api_key,
                model_name,
                base_url,
                request.model_context,
                user,
            ):
                yield event
                await asyncio.sleep(0)  # yield control so FastAPI can flush
        except Exception as exc:
            import traceback as _tb
            import json
            tb = _tb.format_exc()
            logger.error("Stream agent error: %s\n%s", exc, tb)
            # Include last 2 traceback lines so the client can show which file/line
            tb_tail = " | ".join(
                l.strip() for l in tb.splitlines() if l.strip() and not l.strip().startswith("Traceback")
            )[-300:]
            yield f"data: {json.dumps({'type': 'error', 'message': _friendly_error_message(exc), 'detail': tb_tail})}\n\n"
        finally:
            release_conn(conn)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
        },
    )
