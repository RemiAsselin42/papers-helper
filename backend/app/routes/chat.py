from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.ollama_service import OllamaGenerationService

router = APIRouter(prefix="/projects/{project_id}", tags=["chat"])


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]


@router.post("/chat")
async def chat(project_id: str, req: ChatRequest) -> StreamingResponse:
    svc = OllamaGenerationService(model=req.model)
    raw_messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    async def event_stream() -> AsyncGenerator[str, None]:
        async for token in svc.stream_generate_messages(raw_messages):
            payload = json.dumps({"token": token})
            yield f"data: {payload}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
