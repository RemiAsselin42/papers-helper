"""Concept extraction: LLM response parsing and graceful failure paths."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.graph.concepts import _parse_concepts, extract_concepts


def _gen(*outputs: str):  # type: ignore[no-untyped-def]
    """Build a fake LLM generator that yields *outputs* and then completes."""

    async def factory(messages: list[dict[str, Any]]) -> AsyncIterator[str]:
        for token in outputs:
            yield token

    return factory


class TestParseConcepts:
    def test_clean_json_array(self) -> None:
        assert _parse_concepts('["a", "b", "c"]', max_concepts=5) == ["a", "b", "c"]

    def test_code_fence_stripped(self) -> None:
        text = '```json\n["a", "b"]\n```'
        assert _parse_concepts(text, max_concepts=5) == ["a", "b"]

    def test_prose_around_array(self) -> None:
        text = 'Sure, here are the concepts:\n["x", "y"]\nLet me know if you need more.'
        assert _parse_concepts(text, max_concepts=5) == ["x", "y"]

    def test_dedup_casefolded(self) -> None:
        assert _parse_concepts('["AI", "ai", "ML"]', max_concepts=5) == ["AI", "ML"]

    def test_caps_at_max(self) -> None:
        text = '["a", "b", "c", "d", "e", "f"]'
        assert _parse_concepts(text, max_concepts=3) == ["a", "b", "c"]

    def test_non_strings_filtered(self) -> None:
        assert _parse_concepts('["a", 1, null, "b"]', max_concepts=5) == ["a", "b"]

    def test_invalid_returns_empty(self) -> None:
        assert _parse_concepts("garbage no brackets", max_concepts=5) == []
        assert _parse_concepts("[not, json]", max_concepts=5) == []

    def test_empty_input(self) -> None:
        assert _parse_concepts("", max_concepts=5) == []


@pytest.mark.asyncio
async def test_extract_concepts_happy_path() -> None:
    result = await extract_concepts(
        title="Attention Is All You Need",
        abstract="Transformer architecture for sequence modelling.",
        generator=_gen('["Transformers", "Attention", "Sequence Modelling"]'),
    )
    assert result == ["Transformers", "Attention", "Sequence Modelling"]


@pytest.mark.asyncio
async def test_extract_concepts_handles_streamed_tokens() -> None:
    # Simulate the LLM emitting many small tokens.
    chunks = ["[", '"a", ', '"b"', "]"]
    result = await extract_concepts(title="t", abstract="a", generator=_gen(*chunks))
    assert result == ["a", "b"]


@pytest.mark.asyncio
async def test_extract_concepts_empty_inputs() -> None:
    assert await extract_concepts("", "", generator=_gen("['a']")) == []


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
        generator=_gen('["k"]'),
        max_abstract_chars=100,
    )
    assert result == ["k"]
