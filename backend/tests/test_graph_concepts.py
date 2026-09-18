"""Concept extraction: LLM response parsing and graceful failure paths."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import patch

import pytest

from app.config import set_request_ollama_model
from app.graph.concepts import _CONCEPTS_SCHEMA, _parse_concepts, extract_concepts
from app.ollama_service import OllamaGenerationService


def _gen(*outputs: str):  # type: ignore[no-untyped-def]
    """Build a fake LLM generator that yields *outputs* and then completes."""

    async def factory(messages: list[dict[str, Any]]) -> AsyncIterator[str]:
        for token in outputs:
            yield token

    return factory


class TestParseConcepts:
    def test_schema_object(self) -> None:
        assert _parse_concepts('{"concepts": ["a", "b", "c"]}', max_concepts=5) == ["a", "b", "c"]

    def test_dedup_casefolded(self) -> None:
        assert _parse_concepts('{"concepts": ["AI", "ai", "ML"]}', max_concepts=5) == ["AI", "ML"]

    def test_caps_at_max(self) -> None:
        text = '{"concepts": ["a", "b", "c", "d", "e", "f"]}'
        assert _parse_concepts(text, max_concepts=3) == ["a", "b", "c"]

    def test_blank_entries_dropped(self) -> None:
        assert _parse_concepts('{"concepts": [" a ", "", "  "]}', max_concepts=5) == ["a"]

    def test_off_schema_returns_empty(self) -> None:
        assert _parse_concepts('["a", "b"]', max_concepts=5) == []
        assert _parse_concepts('{"concepts": ["a", 1]}', max_concepts=5) == []
        assert _parse_concepts('{"concepts": ["a"', max_concepts=5) == []

    def test_empty_input(self) -> None:
        assert _parse_concepts("", max_concepts=5) == []


@pytest.mark.asyncio
async def test_extract_concepts_happy_path() -> None:
    result = await extract_concepts(
        title="Attention Is All You Need",
        abstract="Transformer architecture for sequence modelling.",
        generator=_gen('{"concepts": ["Transformers", "Attention", "Sequence Modelling"]}'),
    )
    assert result == ["Transformers", "Attention", "Sequence Modelling"]


@pytest.mark.asyncio
async def test_extract_concepts_handles_streamed_tokens() -> None:
    # Simulate the LLM emitting many small tokens.
    chunks = ['{"conc', 'epts": [', '"a", ', '"b"', "]}"]
    result = await extract_concepts(title="t", abstract="a", generator=_gen(*chunks))
    assert result == ["a", "b"]


@pytest.mark.asyncio
async def test_default_generator_uses_picked_model_schema_and_cap() -> None:
    calls: list[tuple[str, dict[str, Any] | None, dict[str, Any] | None]] = []

    async def fake_stream(
        self: OllamaGenerationService,
        messages: list[dict[str, Any]],
        json_schema: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        calls.append((self.model, json_schema, options))
        yield '{"concepts": ["a"]}'

    # Set as the middleware does from X-Ollama-Model; the test runs in its own
    # task, so the context value doesn't leak into other tests.
    set_request_ollama_model("qwen3:4b")
    with patch.object(OllamaGenerationService, "stream_generate_messages", fake_stream):
        assert await extract_concepts(title="t", abstract="a") == ["a"]
    assert calls == [("qwen3:4b", _CONCEPTS_SCHEMA, {"num_predict": 200})]


@pytest.mark.asyncio
async def test_extract_concepts_empty_inputs() -> None:
    assert await extract_concepts("", "", generator=_gen('{"concepts": ["a"]}')) == []


@pytest.mark.asyncio
async def test_extract_concepts_generator_raises_returns_empty() -> None:
    async def boom(_messages: list[dict[str, Any]]) -> AsyncIterator[str]:
        raise RuntimeError("network down")
        yield ""  # pragma: no cover — make this an async generator

    assert await extract_concepts("t", "a", generator=boom) == []


@pytest.mark.asyncio
async def test_extract_concepts_caps_abstract_length() -> None:
    # Should not raise even when the abstract is huge — truncation happens
    # before the prompt is built.
    huge = "x" * 100_000
    result = await extract_concepts(
        title="t",
        abstract=huge,
        generator=_gen('{"concepts": ["k"]}'),
        max_abstract_chars=100,
    )
    assert result == ["k"]
