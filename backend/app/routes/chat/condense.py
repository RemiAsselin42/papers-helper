"""Map-reduce summarisation primitive used by the /condense endpoint.

The chat endpoint's mention RAG runs a top-k semantic query against the user's
message — fine for "what does paper X say about Y?" style chat, useless for
"summarise paper X" style calls because the instruction has no semantic
neighbours in the source body. /condense bypasses that path entirely:

- Short doc that fits in the chosen provider's context → a single full-doc call.
- Long doc, or Ollama provider (small local context) → map step over each chunk
  via Ollama, then a final reduce on the chosen provider.
- Multiple stems → map-reduce per stem, then a global reduce.

The map step always runs on Ollama because it's local and cheap; the reduce
honours the user-chosen provider so the final synthesis benefits from the
larger / better model when one is configured.

Event protocol (yielded by the async generators here, serialised to SSE by
the route handler):

- ``{"token": "..."}``        — a streamed reduce token to splice into the UI
- ``{"progress": {...}}``     — a phase change or counter update for the UI
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any, Literal

from app.chroma import get_collection
from app.config import (
    CONDENSE_FULL_DOC_CONTEXT_RATIO,
    CONDENSE_MAP_MAX_CONCURRENCY,
    CONDENSE_MAP_WINDOW_WORDS,
    CONDENSE_TOKENS_PER_CHUNK_ESTIMATE,
)
from app.llm_service import ExternalLLMService, LLMProvider, get_context_limit
from app.ollama_service import OllamaGenerationService

Strategy = Literal["full", "map_reduce_single", "map_reduce_multi"]
Event = dict[str, Any]

# Small local models (llama3) answer in English and prepend chatty
# meta-commentary ("What a treasure trove of text summaries!…") plus Markdown
# when handed a "combine these summaries" framing. This directive forbids all
# of it; the reduce templates also place it LAST (after the content) because
# small models weight the tail of the prompt most.
_NO_PREAMBLE_DIRECTIVE = (
    "Contraintes de rédaction strictes. Écris en français. Commence "
    "directement par la première phrase du résumé : n'écris aucune phrase "
    "d'introduction ni aucun commentaire méta (jamais « Voici… », "
    "« Here's a… », « After analyzing… », « What a treasure trove… » ou "
    "équivalent). Termine sur la dernière phrase utile, sans conclusion du "
    "type « En résumé… » ou « Overall… ». Rédige en texte brut : aucun "
    "formatage Markdown, pas de gras ni d'astérisques, pas de listes à puces "
    "ou numérotées, pas de titres."
)

MAP_PROMPT_TEMPLATE = (
    "Voici un extrait d'un document plus long. Tâche demandée : {prompt}\n"
    "Concentre-toi uniquement sur les éléments présents dans cet extrait "
    "qui sont pertinents pour cette tâche. Réponds en français, en quelques "
    "phrases de texte brut, sans préambule ni formatage Markdown.\n\n"
    "--- EXTRAIT ---\n{chunk}"
)

# Instruction-last layout: the notes come first, the task + constraints come
# after, so the model's most recent context is "do this task", not "here is a
# list of summaries" (which it tends to answer with meta-commentary).
REDUCE_PROMPT_TEMPLATE = (
    "Tu disposes de notes de lecture prises sur les parties successives "
    "d'un même document, dans l'ordre.\n\n"
    "--- NOTES DE LECTURE ---\n{partials}\n--- FIN DES NOTES ---\n\n"
    "En t'appuyant uniquement sur ces notes, effectue la tâche suivante.\n"
    "Tâche : {prompt}\n\n"
    f"{_NO_PREAMBLE_DIRECTIVE}"
)

GLOBAL_REDUCE_PROMPT_TEMPLATE = (
    "Tu disposes d'un résumé par document.\n\n"
    "--- RÉSUMÉS PAR DOCUMENT ---\n{per_doc}\n--- FIN ---\n\n"
    "En t'appuyant uniquement sur ces résumés, effectue la tâche suivante "
    "(référence chaque document si pertinent).\n"
    "Tâche : {prompt}\n\n"
    f"{_NO_PREAMBLE_DIRECTIVE}"
)


def _chunk_idx(meta: dict[str, Any]) -> int:
    try:
        return int(meta.get("chunk_index", 0))
    except (TypeError, ValueError):
        return 0


def _fetch_chunks_for_stem(collection: Any, stem: str) -> list[tuple[int, str]]:
    """Return all chunks of `stem` as (chunk_index, document) sorted by index."""
    res = collection.get(
        where={"source_stem": stem},
        include=["documents", "metadatas"],
    )
    docs = res.get("documents") or []
    metas = res.get("metadatas") or []
    rows: list[tuple[int, str]] = []
    for doc, meta in zip(docs, metas, strict=False):
        if not doc:
            continue
        rows.append((_chunk_idx(dict(meta) if meta else {}), doc))
    rows.sort(key=lambda r: r[0])
    return rows


def _fetch_full_stem_untruncated(collection: Any, stem: str) -> str:
    """Reassemble the full body of `stem` from its chunks, in chunk order.

    Distinct from app.routes.chat.context._fetch_full_stem, which caps the body
    at CHAT_MENTION_CONTENT_CHAR_CAP for chat injection. /condense's full
    strategy is only chosen when the doc fits in the provider's context window,
    so truncation here would silently defeat the strategy's premise.
    """
    rows = _fetch_chunks_for_stem(collection, stem)
    return "\n\n".join(doc for _idx, doc in rows).strip()


def _window_chunks(chunks: list[tuple[int, str]], max_words: int) -> list[tuple[int, str]]:
    """Group consecutive chunks into windows of at most `max_words` words.

    Cuts the number of map-step LLM calls roughly N-fold (a 200-page doc goes
    from ~200 chunks to ~25 windows). Windows are re-indexed 0..M so progress
    counters and chunk ordering stay consistent. A single chunk that already
    exceeds `max_words` becomes its own window — never split further.
    """
    windows: list[tuple[int, str]] = []
    bucket: list[str] = []
    bucket_words = 0
    for _idx, doc in chunks:
        words = len(doc.split())
        if bucket and bucket_words + words > max_words:
            windows.append((len(windows), "\n\n".join(bucket)))
            bucket = []
            bucket_words = 0
        bucket.append(doc)
        bucket_words += words
    if bucket:
        windows.append((len(windows), "\n\n".join(bucket)))
    return windows


def _count_chunks(collection: Any, stems: list[str]) -> dict[str, int]:
    """Single Chroma read returning {stem: chunk_count} for the input stems."""
    in_values: list[str | int | float | bool] = list(stems)
    where: dict[str, Any] = {"source_stem": {"$in": in_values}}
    res = collection.get(where=where, include=["metadatas"])
    metas = res.get("metadatas") or []
    counts: dict[str, int] = {s: 0 for s in stems}
    for meta in metas:
        if not meta:
            continue
        stem = str(dict(meta).get("source_stem") or "")
        if stem in counts:
            counts[stem] += 1
    return counts


def _estimate_tokens(counts: dict[str, int]) -> int:
    return sum(counts.values()) * CONDENSE_TOKENS_PER_CHUNK_ESTIMATE


def _decide_strategy(
    provider: LLMProvider, model: str, total_tokens: int, n_stems: int
) -> Strategy:
    if n_stems > 1:
        return "map_reduce_multi"
    if provider == LLMProvider.OLLAMA:
        return "map_reduce_single"
    threshold = int(get_context_limit(provider, model) * CONDENSE_FULL_DOC_CONTEXT_RATIO)
    if total_tokens < threshold:
        return "full"
    return "map_reduce_single"


def _ollama_service(ollama_model: str, ollama_base_url: str | None) -> OllamaGenerationService:
    return OllamaGenerationService(model=ollama_model, base_url=ollama_base_url)


def _reducer_service(
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_base_url: str | None,
) -> OllamaGenerationService | ExternalLLMService:
    if provider == LLMProvider.OLLAMA:
        return OllamaGenerationService(model=model, base_url=ollama_base_url)
    assert api_key is not None  # caller validated
    return ExternalLLMService(provider=provider, api_key=api_key, model=model)


async def _collect_tokens(gen: AsyncGenerator[str, None]) -> str:
    parts: list[str] = []
    async for t in gen:
        parts.append(t)
    return "".join(parts)


async def run_single_generation(
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_base_url: str | None,
    content: str,
) -> str:
    """One-shot LLM generation: send `content` as a single user message and
    return the full collected response.

    Used by /categorize, whose prompt is short and single-pass — no map-reduce
    fan-out, no Chroma read.
    """
    svc = _reducer_service(provider, model, api_key, ollama_base_url)
    messages = [{"role": "user", "content": content}]
    return await _collect_tokens(svc.stream_generate_messages(messages))


async def _map_one(
    semaphore: asyncio.Semaphore,
    svc: OllamaGenerationService,
    prompt: str,
    chunk: str,
    index: int,
) -> tuple[int, str]:
    """Single map call. Returns (index, partial_summary) so callers can sort."""
    async with semaphore:
        messages = [
            {"role": "user", "content": MAP_PROMPT_TEMPLATE.format(prompt=prompt, chunk=chunk)}
        ]
        partial = await _collect_tokens(svc.stream_generate_messages(messages))
        return index, partial


def _map_progress_payload(
    done: int,
    total: int,
    stem: str | None,
    stem_index: int | None,
    stems_total: int | None,
) -> Event:
    payload: dict[str, Any] = {"phase": "map", "done": done, "total": total}
    if stem is not None:
        payload["stem"] = stem
    if stem_index is not None:
        payload["stem_index"] = stem_index
    if stems_total is not None:
        payload["stems_total"] = stems_total
    return {"progress": payload}


def _map_with_progress(
    chunks: list[tuple[int, str]],
    ollama_model: str,
    ollama_base_url: str | None,
    prompt: str,
    stem: str | None = None,
    stem_index: int | None = None,
    stems_total: int | None = None,
) -> tuple[AsyncGenerator[Event, None], list[str]]:
    """Run the map step over all chunks in bounded parallel, yielding a
    ``{"progress": {phase: "map", done, total, ...}}`` event after each
    completion (in completion order, not chunk order).

    Returns ``(events, partials_out)``: a progress-event generator and a list
    that the caller can read once the generator is exhausted — it is then
    populated in chunk order with the per-chunk partial summaries.
    """
    partials_out: list[str] = []
    svc = _ollama_service(ollama_model, ollama_base_url)

    async def _events() -> AsyncGenerator[Event, None]:
        semaphore = asyncio.Semaphore(CONDENSE_MAP_MAX_CONCURRENCY)
        tasks = [asyncio.create_task(_map_one(semaphore, svc, prompt, doc, i)) for i, doc in chunks]
        total = len(tasks)
        yield _map_progress_payload(0, total, stem, stem_index, stems_total)

        partials_by_idx: dict[int, str] = {}
        completed = 0
        try:
            for fut in asyncio.as_completed(tasks):
                idx, partial = await fut
                partials_by_idx[idx] = partial
                completed += 1
                yield _map_progress_payload(completed, total, stem, stem_index, stems_total)
        finally:
            # If the consumer disconnected mid-way (Starlette closes the SSE
            # generator), make sure pending Ollama calls don't keep running.
            for t in tasks:
                if not t.done():
                    t.cancel()

        partials_out.extend(partials_by_idx[i] for i, _ in chunks)

    return _events(), partials_out


async def _stream_reduce_tokens(
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_base_url: str | None,
    template: str,
    prompt: str,
    body: str,
    body_key: str,
) -> AsyncGenerator[Event, None]:
    svc = _reducer_service(provider, model, api_key, ollama_base_url)
    user_content = template.format(prompt=prompt, **{body_key: body})
    messages = [{"role": "user", "content": user_content}]
    async for token in svc.stream_generate_messages(messages):
        yield {"token": token}


async def _run_full(
    project_id: str,
    prompt: str,
    stems: list[str],
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_base_url: str | None,
) -> AsyncGenerator[Event, None]:
    yield {"progress": {"phase": "generating"}}
    collection = await asyncio.to_thread(get_collection, project_id)
    bodies: list[str] = []
    for stem in stems:
        body = await asyncio.to_thread(_fetch_full_stem_untruncated, collection, stem)
        if body:
            bodies.append(body)
    joined = "\n\n".join(bodies)
    if not joined.strip():
        raise ValueError("Aucun contenu indexé trouvé pour les sources demandées.")
    svc = _reducer_service(provider, model, api_key, ollama_base_url)
    messages = [{"role": "user", "content": f"Tâche : {prompt}\n\n--- DOCUMENT ---\n{joined}"}]
    async for token in svc.stream_generate_messages(messages):
        yield {"token": token}


async def _run_map_reduce_single(
    project_id: str,
    prompt: str,
    stem: str,
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_model: str,
    ollama_base_url: str | None,
) -> AsyncGenerator[Event, None]:
    collection = await asyncio.to_thread(get_collection, project_id)
    chunks = await asyncio.to_thread(_fetch_chunks_for_stem, collection, stem)
    if not chunks:
        return

    windows = _window_chunks(chunks, CONDENSE_MAP_WINDOW_WORDS)
    events, partials = _map_with_progress(windows, ollama_model, ollama_base_url, prompt)
    async for evt in events:
        yield evt

    joined = "\n\n".join(f"[{i + 1}] {p.strip()}" for i, p in enumerate(partials) if p.strip())
    yield {"progress": {"phase": "reduce"}}
    async for evt in _stream_reduce_tokens(
        provider,
        model,
        api_key,
        ollama_base_url,
        REDUCE_PROMPT_TEMPLATE,
        prompt,
        joined,
        "partials",
    ):
        yield evt


async def _run_map_reduce_multi(
    project_id: str,
    prompt: str,
    stems: list[str],
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_model: str,
    ollama_base_url: str | None,
) -> AsyncGenerator[Event, None]:
    collection = await asyncio.to_thread(get_collection, project_id)
    per_doc_summaries: list[str] = []
    stems_total = len(stems)

    for stem_index, stem in enumerate(stems, start=1):
        chunks = await asyncio.to_thread(_fetch_chunks_for_stem, collection, stem)
        if not chunks:
            continue

        windows = _window_chunks(chunks, CONDENSE_MAP_WINDOW_WORDS)
        events, partials = _map_with_progress(
            windows,
            ollama_model,
            ollama_base_url,
            prompt,
            stem=stem,
            stem_index=stem_index,
            stems_total=stems_total,
        )
        async for evt in events:
            yield evt

        joined = "\n\n".join(f"[{i + 1}] {p.strip()}" for i, p in enumerate(partials) if p.strip())
        yield {
            "progress": {
                "phase": "reduce",
                "stem": stem,
                "stem_index": stem_index,
                "stems_total": stems_total,
            }
        }
        # Per-stem reduce is collected, not streamed — the user only sees the
        # final global reduce stream below.
        svc = _reducer_service(provider, model, api_key, ollama_base_url)
        msg = [
            {
                "role": "user",
                "content": REDUCE_PROMPT_TEMPLATE.format(prompt=prompt, partials=joined),
            }
        ]
        summary = await _collect_tokens(svc.stream_generate_messages(msg))
        if summary.strip():
            per_doc_summaries.append(f"## {stem}\n{summary.strip()}")

    body = "\n\n".join(per_doc_summaries)
    yield {"progress": {"phase": "global_reduce"}}
    async for evt in _stream_reduce_tokens(
        provider,
        model,
        api_key,
        ollama_base_url,
        GLOBAL_REDUCE_PROMPT_TEMPLATE,
        prompt,
        body,
        "per_doc",
    ):
        yield evt


async def _wrap_with_start_event(
    strategy: Strategy, gen: AsyncGenerator[Event, None]
) -> AsyncGenerator[Event, None]:
    """Prepend a start event so the UI can populate its progress panel
    immediately with the chosen strategy, before the first map call kicks in."""
    yield {"progress": {"phase": "start", "strategy": strategy}}
    async for evt in gen:
        yield evt


async def run_condense(
    project_id: str,
    prompt: str,
    stems: list[str],
    provider: LLMProvider,
    model: str,
    api_key: str | None,
    ollama_model: str | None,
    ollama_base_url: str | None,
) -> tuple[Strategy, AsyncGenerator[Event, None]]:
    """Decide the strategy from corpus size + provider, then return the event
    generator. Each yielded item is either ``{"token": str}`` or
    ``{"progress": dict}`` — the route handler serialises both to SSE."""
    collection = await asyncio.to_thread(get_collection, project_id)
    counts = await asyncio.to_thread(_count_chunks, collection, stems)
    total_chunks = sum(counts.values())
    if total_chunks == 0:
        raise ValueError("Aucun contenu indexé trouvé pour les sources demandées.")

    total_tokens = _estimate_tokens(counts)
    strategy = _decide_strategy(provider, model, total_tokens, len(stems))

    if strategy in ("map_reduce_single", "map_reduce_multi") and provider != LLMProvider.OLLAMA:
        if not ollama_model:
            raise ValueError(
                "Document trop volumineux pour le contexte du modèle externe : "
                "Ollama requis pour la pré-réduction (X-Ollama-Model manquant)."
            )

    effective_ollama_model = ollama_model or model

    if strategy == "full":
        gen: AsyncGenerator[Event, None] = _run_full(
            project_id, prompt, stems, provider, model, api_key, ollama_base_url
        )
    elif strategy == "map_reduce_single":
        gen = _run_map_reduce_single(
            project_id,
            prompt,
            stems[0],
            provider,
            model,
            api_key,
            effective_ollama_model,
            ollama_base_url,
        )
    else:
        gen = _run_map_reduce_multi(
            project_id,
            prompt,
            stems,
            provider,
            model,
            api_key,
            effective_ollama_model,
            ollama_base_url,
        )
    return strategy, _wrap_with_start_event(strategy, gen)


__all__ = [
    "GLOBAL_REDUCE_PROMPT_TEMPLATE",
    "MAP_PROMPT_TEMPLATE",
    "REDUCE_PROMPT_TEMPLATE",
    "Event",
    "Strategy",
    "_count_chunks",
    "_decide_strategy",
    "_estimate_tokens",
    "_fetch_chunks_for_stem",
    "_window_chunks",
    "run_condense",
    "run_single_generation",
]
