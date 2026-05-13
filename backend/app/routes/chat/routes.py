from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import (
    CHAT_MENTION_CONTENT_CHAR_CAP,
    CHAT_MENTION_TOTAL_CHAR_CAP,
)
from app.llm_service import ExternalLLMService, LLMProvider
from app.ollama_service import OllamaGenerationService
from app.routes.chat.context import (
    _format_problematique_context,
    _retrieve_global_context,
    _retrieve_mention_context,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["chat"])


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]


PLAIN_TEXT_SYSTEM_PROMPT = (
    "Répondez en texte brut uniquement. N'utilisez aucune mise en forme Markdown "
    "(pas de **gras**, pas de *italique*, pas de titres `#`, pas de listes `-`/`*`/`1.`, "
    "pas de blocs de code, pas de tableaux). Utilisez des phrases simples et des sauts de ligne."
)

# Hard ceiling on mention count per request. A malicious or buggy client cannot
# force the backend to iterate Chroma N times for arbitrarily large N.
MENTION_MAX_COUNT = 20


def _parse_mentions_header(raw: str | None) -> list[str]:
    if not raw:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for piece in raw.split(","):
        stem = unquote(piece.strip())
        if stem and stem not in seen:
            seen.add(stem)
            out.append(stem)
    if len(out) > MENTION_MAX_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Too many mentions (max {MENTION_MAX_COUNT}).",
        )
    return out


def _last_user_query(messages: list[dict[str, Any]]) -> str | None:
    for m in reversed(messages):
        if m["role"] == "user":
            return str(m["content"])
    return None


@router.post("/chat")
async def chat(
    project_id: str,
    req: ChatRequest,
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
    x_prefer_plain_text: str | None = Header(default=None),
    x_chat_mentions: str | None = Header(default=None),
    x_chat_neighbor_chunks: str | None = Header(default=None),
    x_chat_global_rag: str | None = Header(default=None),
) -> StreamingResponse:
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

    # The frontend (`detoxOutgoingMessages` in api/chat.ts) is the authoritative
    # rewriter of `@Type/filename` tokens → `« filename »` in user-typed
    # content. We trust that here: the backend no longer applies a second
    # regex-based pass, so the two implementations cannot drift apart on
    # spaced filenames or other edge cases.
    raw_messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    # Frontend sends "1" when enabled. Neighbor chunks default ON (omitted
    # header is treated as enabled); global RAG defaults OFF.
    include_neighbors = x_chat_neighbor_chunks != "0"
    global_rag_enabled = x_chat_global_rag == "1"

    mention_stems = _parse_mentions_header(x_chat_mentions)
    user_query = _last_user_query(raw_messages)

    # System messages are prepended in reverse priority order so the final
    # arrangement is: [problematique, mentions, global RAG, plain-text, …user/assistant…].
    # We insert at index 0 from least-to-most-important, so the most stable
    # framing (problematique) ends up on top.
    if x_prefer_plain_text == "1":
        raw_messages.insert(0, {"role": "system", "content": PLAIN_TEXT_SYSTEM_PROMPT})

    if global_rag_enabled and user_query:
        global_block = await asyncio.to_thread(
            _retrieve_global_context, project_id, user_query
        )
        if global_block:
            raw_messages.insert(0, {"role": "system", "content": global_block})

    if mention_stems:
        mention_block = await asyncio.to_thread(
            _retrieve_mention_context,
            project_id,
            mention_stems,
            user_query,
            include_neighbors,
        )
        if mention_block:
            raw_messages.insert(0, {"role": "system", "content": mention_block})

    problem_block = await asyncio.to_thread(_format_problematique_context, project_id)
    if problem_block:
        raw_messages.insert(0, {"role": "system", "content": problem_block})

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
        # Stream tokens; if the upstream provider raises mid-stream (auth error,
        # quota, network…), surface a final `error` event so the frontend can
        # display it. Without this, StreamingResponse has already sent 200 OK
        # and the connection just closes silently — the user sees nothing.
        try:
            async for token in token_stream:
                yield f"data: {json.dumps({'token': token})}\n\n"
        except Exception as exc:  # noqa: BLE001 — must catch all to surface
            message = str(exc) or exc.__class__.__name__
            yield f"data: {json.dumps({'error': message})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# Test-suite aliases preserved for legacy direct imports of the cap constants
# under their pre-split names.
MENTION_CONTENT_CHAR_CAP = CHAT_MENTION_CONTENT_CHAR_CAP
MENTION_TOTAL_CHAR_CAP = CHAT_MENTION_TOTAL_CHAR_CAP


__all__ = [
    "MENTION_CONTENT_CHAR_CAP",
    "MENTION_MAX_COUNT",
    "MENTION_TOTAL_CHAR_CAP",
    "PLAIN_TEXT_SYSTEM_PROMPT",
    "ChatMessage",
    "ChatRequest",
    "chat",
    "router",
]
