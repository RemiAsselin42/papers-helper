"""FastAPI endpoint for the /condense primitive.

Stays thin: input validation, provider/header parsing, and SSE wrapping. All
strategy decisions and LLM orchestration live in `condense.py`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import CONDENSE_MAX_STEMS
from app.llm_service import LLMProvider
from app.routes.chat.condense import run_condense

router = APIRouter(prefix="/projects/{project_id}", tags=["condense"])


class CondenseRequest(BaseModel):
    prompt: str
    stems: list[str]
    model: str


@router.post("/condense")
async def condense(
    project_id: str,
    req: CondenseRequest,
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
    x_ollama_model: str | None = Header(default=None),
) -> StreamingResponse:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt vide")
    if not req.model.strip():
        raise HTTPException(status_code=400, detail="model vide")
    if not req.stems:
        raise HTTPException(status_code=400, detail="au moins une source requise")
    if len(req.stems) > CONDENSE_MAX_STEMS:
        raise HTTPException(
            status_code=400,
            detail=f"trop de sources (max {CONDENSE_MAX_STEMS})",
        )

    provider = LLMProvider.OLLAMA
    if x_llm_provider:
        try:
            provider = LLMProvider(x_llm_provider)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown LLM provider: {x_llm_provider}")
    if provider != LLMProvider.OLLAMA and not x_llm_api_key:
        raise HTTPException(
            status_code=400,
            detail="X-LLM-API-Key header required for external providers",
        )

    try:
        # ollama_base_url=None lets OllamaGenerationService pick up the per-request
        # URL set by the X-Ollama-URL middleware (same path as /chat).
        _strategy, token_stream = await run_condense(
            project_id=project_id,
            prompt=req.prompt,
            stems=req.stems,
            provider=provider,
            model=req.model,
            api_key=x_llm_api_key,
            ollama_model=x_ollama_model,
            ollama_base_url=None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            async for evt in token_stream:
                yield f"data: {json.dumps(evt)}\n\n"
        except Exception as exc:  # noqa: BLE001 — surface every provider failure
            message = str(exc) or exc.__class__.__name__
            yield f"data: {json.dumps({'error': message})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


__all__ = ["CondenseRequest", "condense", "router"]
