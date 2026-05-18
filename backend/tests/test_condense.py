"""Tests for the /condense endpoint and its strategy router."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.llm_service import (
    DEFAULT_CONTEXT_LIMIT,
    LLMProvider,
    get_context_limit,
)
from app.main import app
from app.routes.chat.condense import (
    GLOBAL_REDUCE_PROMPT_TEMPLATE,
    REDUCE_PROMPT_TEMPLATE,
    _decide_strategy,
    _window_chunks,
)


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# get_context_limit
# ---------------------------------------------------------------------------


def test_context_limit_anthropic_claude_family() -> None:
    assert get_context_limit(LLMProvider.ANTHROPIC, "claude-3-5-sonnet-20240620") == 200_000
    assert get_context_limit(LLMProvider.ANTHROPIC, "claude-opus-4-7") == 200_000


def test_context_limit_openai_longest_prefix_wins() -> None:
    # gpt-4.1 (1M) must win over a hypothetical shorter gpt-4 prefix.
    assert get_context_limit(LLMProvider.OPENAI, "gpt-4.1-mini") == 1_000_000
    assert get_context_limit(LLMProvider.OPENAI, "gpt-4o-mini") == 128_000
    assert get_context_limit(LLMProvider.OPENAI, "o3-mini") == 200_000


def test_context_limit_unknown_falls_back_to_default() -> None:
    assert get_context_limit(LLMProvider.OPENAI, "weirdo-7b") == DEFAULT_CONTEXT_LIMIT
    assert get_context_limit(LLMProvider.OLLAMA, "anything") == DEFAULT_CONTEXT_LIMIT


# ---------------------------------------------------------------------------
# _decide_strategy
# ---------------------------------------------------------------------------


def test_decide_strategy_multi_stem_always_multi() -> None:
    assert _decide_strategy(LLMProvider.ANTHROPIC, "claude-x", 100, 2) == "map_reduce_multi"
    assert _decide_strategy(LLMProvider.OLLAMA, "llama3", 100, 5) == "map_reduce_multi"


def test_decide_strategy_ollama_always_map_reduce_single() -> None:
    assert _decide_strategy(LLMProvider.OLLAMA, "llama3", 100, 1) == "map_reduce_single"
    assert _decide_strategy(LLMProvider.OLLAMA, "llama3", 10_000_000, 1) == "map_reduce_single"


def test_decide_strategy_external_full_when_under_threshold() -> None:
    # Anthropic claude has 200k limit × 0.7 = 140k threshold.
    assert _decide_strategy(LLMProvider.ANTHROPIC, "claude-x", 100_000, 1) == "full"


def test_decide_strategy_external_map_reduce_when_over_threshold() -> None:
    assert _decide_strategy(LLMProvider.ANTHROPIC, "claude-x", 180_000, 1) == "map_reduce_single"


# ---------------------------------------------------------------------------
# Endpoint validation
# ---------------------------------------------------------------------------


def test_condense_rejects_empty_prompt(client: TestClient) -> None:
    response = client.post(
        "/projects/p/condense",
        json={"prompt": "   ", "stems": ["a"], "model": "llama3"},
    )
    assert response.status_code == 400
    assert "prompt" in response.json()["detail"]


def test_condense_rejects_empty_stems(client: TestClient) -> None:
    response = client.post(
        "/projects/p/condense",
        json={"prompt": "résume", "stems": [], "model": "llama3"},
    )
    assert response.status_code == 400


def test_condense_rejects_too_many_stems(client: TestClient) -> None:
    from app.config import CONDENSE_MAX_STEMS

    response = client.post(
        "/projects/p/condense",
        json={
            "prompt": "résume",
            "stems": [f"s{i}" for i in range(CONDENSE_MAX_STEMS + 1)],
            "model": "llama3",
        },
    )
    assert response.status_code == 400
    assert "trop" in response.json()["detail"]


def test_condense_rejects_unknown_provider(client: TestClient) -> None:
    response = client.post(
        "/projects/p/condense",
        headers={"X-LLM-Provider": "bogus", "X-LLM-API-Key": "k"},
        json={"prompt": "résume", "stems": ["a"], "model": "m"},
    )
    assert response.status_code == 400


def test_condense_external_provider_requires_api_key(client: TestClient) -> None:
    response = client.post(
        "/projects/p/condense",
        headers={"X-LLM-Provider": "anthropic"},
        json={"prompt": "résume", "stems": ["a"], "model": "claude"},
    )
    assert response.status_code == 400
    assert "X-LLM-API-Key" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Endpoint integration via mocked Chroma + LLM services
# ---------------------------------------------------------------------------


def _fake_collection(stem_chunks: dict[str, list[str]]) -> Any:
    """Return a fake Chroma collection that responds to .get(where=...) for the
    full-doc fetch, the chunk-count probe, and the per-stem chunk fetch."""

    class _Fake:
        def get(self, **kwargs: Any) -> dict[str, Any]:
            where = kwargs.get("where") or {}
            stem_filter = where.get("source_stem")
            if isinstance(stem_filter, dict) and "$in" in stem_filter:
                stems = list(stem_filter["$in"])
            else:
                stems = [stem_filter] if stem_filter else []

            docs: list[str] = []
            metas: list[dict[str, Any]] = []
            for stem in stems:
                for i, doc in enumerate(stem_chunks.get(stem, [])):
                    docs.append(doc)
                    metas.append(
                        {
                            "chunk_index": i,
                            "source_stem": stem,
                            "source_filename": f"{stem}.pdf",
                            "source_type": "pdf",
                            "chunk_total": len(stem_chunks.get(stem, [])),
                        }
                    )
            return {
                "documents": docs,
                "metadatas": metas,
                "ids": [f"id{i}" for i in range(len(docs))],
            }

    return _Fake()


def test_condense_full_strategy_short_doc_anthropic(client: TestClient) -> None:
    """Short doc + external provider → single full-doc call, no Ollama map step."""
    captured_messages: list[list[dict[str, Any]]] = []

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured_messages.append(messages)
        yield "résumé final"

    fake = _fake_collection({"paper-a": ["paragraphe 1.", "paragraphe 2."]})

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        patch(
            "app.llm_service.ExternalLLMService.stream_generate_messages",
            new=_capture,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            headers={"X-LLM-Provider": "anthropic", "X-LLM-API-Key": "k"},
            json={
                "prompt": "Rédige un résumé.",
                "stems": ["paper-a"],
                "model": "claude-3-5-sonnet",
            },
        )
    assert response.status_code == 200
    # SSE encodes the token via json.dumps which escapes non-ASCII; check both
    # the escaped form in transport and the raw token surfaced to messages.
    assert "r\\u00e9sum\\u00e9 final" in response.text
    assert "[DONE]" in response.text
    # Exactly one call to the external provider (no map step).
    assert len(captured_messages) == 1
    body = captured_messages[0][0]["content"]
    assert "Rédige un résumé." in body
    assert "paragraphe 1." in body and "paragraphe 2." in body


def test_condense_full_strategy_preserves_long_body(client: TestClient) -> None:
    """Regression: full-strategy must send the full body, not a 20k-char slice.

    The /chat path caps mention bodies at CHAT_MENTION_CONTENT_CHAR_CAP for
    context-injection ergonomics; /condense reuses Chroma but must NOT share
    that cap, since `full` is only chosen when the doc fits in the provider's
    context window. If a future refactor reroutes through the truncating
    fetcher, this test fails because the tail marker disappears from the
    LLM payload.
    """
    captured_messages: list[list[dict[str, Any]]] = []

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured_messages.append(messages)
        yield "ok"

    # 30 chunks × ~1 200 chars ≈ 36k chars — comfortably above the 20k chat cap,
    # well below the 200k Anthropic context. Unique head/tail markers let us
    # assert both ends survive.
    chunks = [f"HEAD-{i:02d} " + ("filler " * 200) + f" TAIL-{i:02d}" for i in range(30)]
    fake = _fake_collection({"paper-long": chunks})

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        patch(
            "app.llm_service.ExternalLLMService.stream_generate_messages",
            new=_capture,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            headers={"X-LLM-Provider": "anthropic", "X-LLM-API-Key": "k"},
            json={
                "prompt": "Résume.",
                "stems": ["paper-long"],
                "model": "claude-3-5-sonnet",
            },
        )
    assert response.status_code == 200
    assert len(captured_messages) == 1
    body = captured_messages[0][0]["content"]
    # First and last chunk markers must both appear — no silent truncation.
    assert "HEAD-00" in body and "TAIL-00" in body
    assert "HEAD-29" in body and "TAIL-29" in body
    assert "[contenu tronqué]" not in body


def test_condense_external_long_doc_requires_ollama_model(client: TestClient) -> None:
    """When the doc exceeds the API context, x_ollama_model is mandatory."""
    long_chunks = ["x" * 1000] * 500  # ~500 chunks → >> 70% of 200k
    fake = _fake_collection({"paper-a": long_chunks})

    with patch("app.routes.chat.condense.get_collection", return_value=fake):
        response = client.post(
            "/projects/p/condense",
            headers={"X-LLM-Provider": "anthropic", "X-LLM-API-Key": "k"},
            json={
                "prompt": "Résume.",
                "stems": ["paper-a"],
                "model": "claude-3-5-sonnet",
            },
        )
    assert response.status_code == 400
    assert "Ollama" in response.json()["detail"]


def test_condense_no_indexed_content_returns_400(client: TestClient) -> None:
    fake = _fake_collection({})  # stem not present

    with patch("app.routes.chat.condense.get_collection", return_value=fake):
        response = client.post(
            "/projects/p/condense",
            json={"prompt": "résume", "stems": ["missing"], "model": "llama3"},
        )
    assert response.status_code == 400
    assert "indexé" in response.json()["detail"]


def test_condense_ollama_map_reduce_single_stem(client: TestClient) -> None:
    """Provider Ollama, single stem, multiple chunks: N map calls + 1 reduce.

    Each call to OllamaGenerationService.stream_generate_messages is captured;
    we verify the pattern (map_*N then reduce) and that the final reduce body
    references all map outputs."""
    seen_messages: list[list[dict[str, Any]]] = []
    call_count = {"n": 0}

    async def _fake_gen(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        seen_messages.append(messages)
        call_count["n"] += 1
        # Return distinguishable output per call so we can assert assembly.
        token = f"M{call_count['n']}"
        yield token

    fake = _fake_collection({"paper-a": ["chunk-A.", "chunk-B.", "chunk-C."]})

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        # Window size of 1 word → each tiny test chunk maps on its own, so the
        # map-step count stays per-chunk (the windowing default would otherwise
        # fold all three into a single window).
        patch("app.routes.chat.condense.CONDENSE_MAP_WINDOW_WORDS", 1),
        patch(
            "app.ollama_service.OllamaGenerationService.stream_generate_messages",
            new=_fake_gen,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            json={"prompt": "Résume.", "stems": ["paper-a"], "model": "llama3"},
        )
    assert response.status_code == 200
    # 3 map calls + 1 reduce = 4 total.
    assert call_count["n"] == 4
    # Reduce input must contain all map outputs.
    reduce_body = seen_messages[-1][0]["content"]
    assert "M1" in reduce_body and "M2" in reduce_body and "M3" in reduce_body
    # Final SSE must contain the reduce token.
    assert "M4" in response.text


def test_condense_emits_progress_events_during_map_reduce(client: TestClient) -> None:
    """The SSE stream must include progress events so the UI can render the
    long-running map step's advancement, not just the final reduce tokens."""
    seen_messages: list[list[dict[str, Any]]] = []

    async def _fake_gen(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        seen_messages.append(messages)
        yield "x"

    fake = _fake_collection({"paper-a": ["c1.", "c2.", "c3.", "c4."]})

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        patch("app.routes.chat.condense.CONDENSE_MAP_WINDOW_WORDS", 1),
        patch(
            "app.ollama_service.OllamaGenerationService.stream_generate_messages",
            new=_fake_gen,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            json={"prompt": "Résume.", "stems": ["paper-a"], "model": "llama3"},
        )
    assert response.status_code == 200
    text = response.text
    # Strategy announcement up-front so the UI can populate the panel before
    # the first map call returns.
    assert '"phase": "start"' in text
    assert '"strategy": "map_reduce_single"' in text
    # Initial 0/4 plus one event per completed chunk plus the reduce phase
    # marker — 4 chunks → 5 map events + 1 reduce event minimum.
    assert text.count('"phase": "map"') >= 5
    assert '"done": 4' in text
    assert '"total": 4' in text
    assert '"phase": "reduce"' in text
    # No internal handoff events leak to the wire.
    assert "_partials" not in text


def test_condense_map_reduce_multi_stem(client: TestClient) -> None:
    """Two stems → 2 per-stem map-reduces + 1 global reduce."""
    seen_messages: list[list[dict[str, Any]]] = []
    call_count = {"n": 0}

    async def _fake_gen(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        seen_messages.append(messages)
        call_count["n"] += 1
        yield f"T{call_count['n']}"

    fake = _fake_collection(
        {
            "paper-a": ["a-chunk-1.", "a-chunk-2."],
            "paper-b": ["b-chunk-1."],
        }
    )

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        patch("app.routes.chat.condense.CONDENSE_MAP_WINDOW_WORDS", 1),
        patch(
            "app.ollama_service.OllamaGenerationService.stream_generate_messages",
            new=_fake_gen,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            json={
                "prompt": "Résume les deux documents.",
                "stems": ["paper-a", "paper-b"],
                "model": "llama3",
            },
        )
    assert response.status_code == 200
    # paper-a: 2 map + 1 reduce = 3 ; paper-b: 1 map + 1 reduce = 2 ; global reduce = 1.
    assert call_count["n"] == 6
    final_reduce_body = seen_messages[-1][0]["content"]
    assert "paper-a" in final_reduce_body
    assert "paper-b" in final_reduce_body


# ---------------------------------------------------------------------------
# _window_chunks — map-step batching
# ---------------------------------------------------------------------------


def test_window_chunks_groups_consecutive_chunks() -> None:
    # 10 chunks of 100 words, 250-word windows → 2 chunks per window.
    chunks = [(i, "word " * 100) for i in range(10)]
    windows = _window_chunks(chunks, 250)
    assert len(windows) == 5
    # Windows are re-indexed 0..N regardless of the source chunk indices.
    assert [w[0] for w in windows] == [0, 1, 2, 3, 4]


def test_window_chunks_oversized_chunk_is_its_own_window() -> None:
    # A chunk already above the window cap is never split — it stands alone.
    chunks = [(0, "word " * 500), (1, "tiny")]
    windows = _window_chunks(chunks, 100)
    assert len(windows) == 2


def test_window_chunks_empty_input() -> None:
    assert _window_chunks([], 4000) == []


def test_reduce_prompts_forbid_preamble_and_enforce_french() -> None:
    # Bug fix: small local models drift to English + chatty headers; every
    # reduce template must carry the explicit no-preamble / French directive.
    for tpl in (REDUCE_PROMPT_TEMPLATE, GLOBAL_REDUCE_PROMPT_TEMPLATE):
        assert "français" in tpl
        assert "After analyzing" in tpl


def test_condense_windows_small_chunks_into_one_map_call(client: TestClient) -> None:
    """With the default window, many small chunks fold into a single map call —
    the optimisation that cuts a 200-page doc from ~200 calls to a handful."""
    call_count = {"n": 0}

    async def _fake_gen(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        call_count["n"] += 1
        yield f"M{call_count['n']}"

    fake = _fake_collection({"paper-a": [f"c{i}." for i in range(20)]})

    with (
        patch("app.routes.chat.condense.get_collection", return_value=fake),
        patch(
            "app.ollama_service.OllamaGenerationService.stream_generate_messages",
            new=_fake_gen,
        ),
    ):
        response = client.post(
            "/projects/p/condense",
            json={"prompt": "Résume.", "stems": ["paper-a"], "model": "llama3"},
        )
    assert response.status_code == 200
    # 20 tiny chunks fit in one 4000-word window → 1 map + 1 reduce.
    assert call_count["n"] == 2
