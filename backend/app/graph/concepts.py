"""Best-effort LLM concept extraction.

Called once per paper at ingestion time (or rebuild) and cached in the
sidecar's `concepts_json` field so subsequent graph operations don't pay the
LLM cost again. Failures are silenced — concepts are an enrichment, not a
hard requirement.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from functools import partial
from typing import Any

from pydantic import BaseModel, ValidationError

from app.config import OLLAMA_GENERATION_MODEL
from app.ollama_service import OllamaGenerationService

log = logging.getLogger(__name__)

GeneratorCallable = Callable[[list[dict[str, Any]]], AsyncIterator[str]]

# Fields whose edits invalidate the cached concepts_json. Centralised so PATCH
# routes don't drift from the inputs `extract_concepts` actually reads.
CONCEPT_INPUT_FIELDS: frozenset[str] = frozenset({"pdf_title", "abstract"})


class _ConceptList(BaseModel):
    concepts: list[str]


# Sent as Ollama's `format`, so the reply is always JSON matching this schema —
# no code fence or prose to strip. An object root is Ollama's documented shape.
_CONCEPTS_SCHEMA = _ConceptList.model_json_schema()

_PROMPT_TEMPLATE = (
    "Extract 3 to 5 distinct concepts or keywords from this academic paper. "
    'Return them in the "concepts" field, as short strings (1-4 words each).\n\n'
    "Title: {title}\n"
    "Abstract: {abstract}\n"
)


def _default_generator() -> GeneratorCallable:
    service = OllamaGenerationService(model=OLLAMA_GENERATION_MODEL)
    return partial(service.stream_generate_messages, json_schema=_CONCEPTS_SCHEMA)


async def extract_concepts(
    title: str,
    abstract: str,
    *,
    generator: GeneratorCallable | None = None,
    max_concepts: int = 5,
    max_abstract_chars: int = 2000,
) -> list[str]:
    """Best-effort concept extraction. Returns `[]` on any failure so the
    caller treats absent concepts as "try again on the next rebuild"."""
    title = (title or "").strip()
    abstract = ((abstract or "")[:max_abstract_chars]).strip()
    if not (title or abstract):
        return []

    if generator is None:
        try:
            generator = _default_generator()
        except Exception as exc:
            log.warning("extract_concepts: cannot build default generator: %s", exc)
            return []

    prompt = _PROMPT_TEMPLATE.format(
        title=title or "(unknown)",
        abstract=abstract or "(unknown)",
    )
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]

    try:
        accumulated = ""
        async for token in generator(messages):
            accumulated += token
    except Exception as exc:
        log.warning("extract_concepts: LLM call failed: %s", exc)
        return []

    return _parse_concepts(accumulated, max_concepts=max_concepts)


def _parse_concepts(text: str, *, max_concepts: int) -> list[str]:
    """Validate the schema-constrained reply, then drop blanks and
    case-insensitive duplicates and cap the list. A reply that doesn't match
    the schema (cut-off stream, a fake generator in tests) yields `[]`."""
    try:
        raw = _ConceptList.model_validate_json(text).concepts
    except ValidationError:
        return []

    out: list[str] = []
    seen: set[str] = set()
    for entry in raw:
        cleaned = entry.strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= max_concepts:
            break
    return out
