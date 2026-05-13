from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.chroma import get_collection
from app.llm_service import ExternalLLMService, LLMProvider
from app.ollama_service import OllamaGenerationService

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

# Cap on characters injected per mentioned source. Picked to comfortably fit a
# handful of mentions even on a small-context model (~8k tokens ≈ 32k chars).
MENTION_CONTENT_CHAR_CAP = 20_000

# Cap on total characters injected across all mentions. Leaves room for the
# user's own prompt and the assistant's reply on small-context models.
MENTION_TOTAL_CHAR_CAP = 60_000

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


def _chunk_idx(meta: dict[str, Any]) -> int:
    try:
        return int(meta.get("chunk_index", 0))
    except (TypeError, ValueError):
        return 0


def _load_mention_context(project_id: str, stems: list[str]) -> str | None:
    """Return a single system-message body that concatenates the indexed
    chunks of every mentioned source. Returns None if no source resolved.

    Uses one batched Chroma query with `$in` so the worst case is a single
    round-trip regardless of mention count.
    """
    if not stems:
        return None
    collection = get_collection(project_id)
    # Chroma's `Where` is a strict TypedDict union; mypy needs help inferring
    # both the literal "$in" key and the widened element type of the values.
    in_values: list[str | int | float | bool] = list(stems)
    where_clause: dict[str, Any] = {"source_stem": {"$in": in_values}}
    res = collection.get(
        where=where_clause,
        include=["documents", "metadatas"],
    )
    ids = res.get("ids") or []
    if not ids:
        return None
    documents = res.get("documents") or []
    metadatas = res.get("metadatas") or []

    # Bucket rows by source_stem, preserving the user-supplied mention order.
    buckets: dict[str, list[tuple[Any, dict[str, Any]]]] = {s: [] for s in stems}
    for doc, meta in zip(documents, metadatas, strict=False):
        meta_d = dict(meta) if meta else {}
        stem = str(meta_d.get("source_stem") or "")
        if stem in buckets:
            buckets[stem].append((doc, meta_d))

    sections: list[str] = []
    for stem in stems:
        rows = buckets.get(stem) or []
        if not rows:
            continue
        rows.sort(key=lambda r: _chunk_idx(r[1]))
        body = "\n\n".join(doc for doc, _meta in rows if doc).strip()
        if not body:
            continue
        if len(body) > MENTION_CONTENT_CHAR_CAP:
            body = body[:MENTION_CONTENT_CHAR_CAP] + "\n…[contenu tronqué]"
        first_meta = rows[0][1]
        filename = str(first_meta.get("source_filename") or stem)
        source_type = str(first_meta.get("source_type") or "document").capitalize()
        sections.append(f"--- @{source_type}/{filename} ---\n{body}")

    if not sections:
        return None

    header = (
        "Contexte fourni par l'utilisateur via des mentions @Type/fichier. "
        "Utilisez ce contenu en priorité pour répondre."
    )

    # Boundary-aware accumulation: drop trailing sections rather than splitting
    # one mid-byte. Guarantees at least the first section is included even if
    # it alone exceeds the total cap (capped per-source above to 20k).
    selected: list[str] = []
    used = 0
    truncated = False
    for sec in sections:
        sep = 2 if selected else 0
        if selected and used + sep + len(sec) > MENTION_TOTAL_CHAR_CAP:
            truncated = True
            break
        selected.append(sec)
        used += sep + len(sec)
    joined = "\n\n".join(selected)
    if truncated:
        joined += "\n…[contexte mentionné tronqué]"
    return f"{header}\n\n{joined}"


@router.post("/chat")
async def chat(
    project_id: str,
    req: ChatRequest,
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
    x_prefer_plain_text: str | None = Header(default=None),
    x_chat_mentions: str | None = Header(default=None),
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

    raw_messages: list[dict[str, Any]] = [
        {"role": m.role, "content": m.content} for m in req.messages
    ]

    mention_stems = _parse_mentions_header(x_chat_mentions)
    if mention_stems:
        mention_block = await asyncio.to_thread(_load_mention_context, project_id, mention_stems)
        if mention_block:
            raw_messages.insert(0, {"role": "system", "content": mention_block})

    if x_prefer_plain_text == "1":
        raw_messages.insert(0, {"role": "system", "content": PLAIN_TEXT_SYSTEM_PROMPT})

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
