import asyncio
import logging
import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from dashboard_auth.dependencies import CurrentUser, get_current_user_optional

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class ChatRequest(BaseModel):
    message: str
    model_id: str | None = None   # normalizer model UUID (bim_models.model_id)
    history: list = []
    ai_provider: str = "mistral"
    openai_config: dict | None = None
    ollama_config: dict | None = None
    lmstudio_config: dict | None = None
    mistral_config: dict | None = None
    anthropic_config: dict | None = None
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
        model_name = cfg.get("model", "mistral-large-latest")
        base_url = ""
    elif provider == "anthropic":
        cfg = request.anthropic_config or {}
        api_key = cfg.get("apiKey") or os.getenv("ANTHROPIC_API_KEY", "")
        model_name = cfg.get("model", "claude-sonnet-5")
        base_url = ""
    elif provider == "ollama":
        cfg = request.ollama_config or {}
        api_key = ""
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
        raise HTTPException(status_code=500, detail=str(exc))
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
            yield f"data: {json.dumps({'type': 'error', 'message': f'{type(exc).__name__}: {exc}', 'detail': tb_tail})}\n\n"
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
