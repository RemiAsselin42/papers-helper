"""Best-effort LLM concept extraction.

Called once per paper at ingestion time (or rebuild) and cached in the
sidecar's `concepts_json` field so subsequent graph operations don't pay the
LLM cost again. Failures are silenced — concepts are an enrichment, not a
hard requirement.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from app.config import OLLAMA_GENERATION_MODEL
from app.ollama_service import OllamaGenerationService

log = logging.getLogger(__name__)

GeneratorCallable = Callable[[list[dict[str, Any]]], AsyncIterator[str]]

# Fields whose edits invalidate the cached concepts_json. Centralised so PATCH
# routes don't drift from the inputs `extract_concepts` actually reads.
CONCEPT_INPUT_FIELDS: frozenset[str] = frozenset({"pdf_title", "abstract"})

_PROMPT_TEMPLATE = (
    "Extract 3 to 5 distinct concepts or keywords from this academic paper. "
    "Return strictly a JSON array of short strings (1-4 words each). "
    "No prose, no markdown, no preamble — only the JSON array.\n\n"
    "Title: {title}\n"
    "Abstract: {abstract}\n"
)


def _default_generator() -> GeneratorCallable:
    service = OllamaGenerationService(model=OLLAMA_GENERATION_MODEL)
    return service.stream_generate_messages


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
    """Pull a JSON array of strings out of an LLM response, tolerating common
    surrounding fluff (code fences, prose preamble, trailing chatter)."""
    if not text:
        return []
    s = text.strip()
    # Strip a leading code fence if present (```json … ``` or ``` … ```).
    if s.startswith("```"):
        first_nl = s.find("\n")
        if first_nl != -1:
            s = s[first_nl + 1 :]
        if s.endswith("```"):
            s = s[:-3]
    s = s.strip()
    # Locate the first JSON array in the text.
    start = s.find("[")
    end = s.rfind("]")
    if start == -1 or end == -1 or end < start:
        return []
    try:
        raw = json.loads(s[start : end + 1])
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, list):
        return []

    out: list[str] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
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
