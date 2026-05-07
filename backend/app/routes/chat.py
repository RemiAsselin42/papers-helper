from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.llm_service import ExternalLLMService, LLMProvider
from app.ollama_service import OllamaGenerationService

router = APIRouter(prefix="/projects/{project_id}", tags=["chat"])


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]


@router.post("/chat")
async def chat(
    project_id: str,
    req: ChatRequest,
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
) -> StreamingResponse:
    provider = LLMProvider.OLLAMA
    if x_llm_provider:
        try:
            provider = LLMProvider(x_llm_provider)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown LLM provider: {x_llm_provider}")

    if provider != LLMProvider.OLLAMA and not x_llm_api_key:
        raise HTTPException(status_code=400, detail="X-LLM-API-Key header required for external providers")

    raw_messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    if provider == LLMProvider.OLLAMA:
        token_stream: AsyncGenerator[str, None] = OllamaGenerationService(
            model=req.model
        ).stream_generate_messages(raw_messages)
    else:
        assert x_llm_api_key is not None
        token_stream = ExternalLLMService(
            provider=provider, api_key=x_llm_api_key, model=req.model
        ).stream_generate_messages(raw_messages)

    async def event_stream() -> AsyncGenerator[str, None]:
        async for token in token_stream:
            yield f"data: {json.dumps({'token': token})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
