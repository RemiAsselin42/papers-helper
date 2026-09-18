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

from app.config import get_ollama_model
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

# The grammar lets the model emit whitespace before `{`, and a small model
# sometimes gets stuck there (seen: 1,000+ tokens and an Ollama `bad_alloc`).
# Naming the JSON shape in the prompt makes it open with `{`; this cap bounds
# the rare runaway left. A normal reply is 40-60 tokens.
_GENERATION_OPTIONS = {"num_predict": 200}

# French, with the language directive last: small local models drift into
# English otherwise, and FR/EN variants of one concept never merge in the graph.
_PROMPT_TEMPLATE = (
    "Extrais de cet article académique 3 à 5 concepts ou mots-clés distincts, "
    "courts (1 à 4 mots chacun). Réponds uniquement par un objet JSON de la "
    'forme {{"concepts": ["…", "…"]}}.\n\n'
    "Titre : {title}\n"
    "Résumé : {abstract}\n\n"
    "Chaque concept doit IMPÉRATIVEMENT être rédigé en français, même si "
    "l'article est en anglais : traduis tout terme anglais (par ex. "
    "« Perceived usefulness » → « Utilité perçue », « Workarounds » → "
    "« Contournements »). Garde tels quels les sigles et les noms de modèles "
    "(TIC, UTAUT, ADKAR)."
)


def _default_generator() -> GeneratorCallable:
    # The model picked in the UI, carried by the request that triggered the
    # graph update (index pass, rebuild, metadata PATCH).
    service = OllamaGenerationService(model=get_ollama_model())
    return partial(
        service.stream_generate_messages,
        json_schema=_CONCEPTS_SCHEMA,
        options=_GENERATION_OPTIONS,
    )


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
        title=title or "(inconnu)",
        abstract=abstract or "(inconnu)",
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
