"""Tests for LLM provider routing in the chat endpoint."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.llm_service import _OPENAI_COMPATIBLE_BASE_URLS, LLMProvider
from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


async def _fake_token_stream(
    _self: Any, _messages: list[dict[str, Any]]
) -> AsyncGenerator[str, None]:
    yield "hi"


def test_unknown_provider_rejected(client: TestClient) -> None:
    response = client.post(
        "/projects/x/chat",
        headers={"X-LLM-Provider": "bogus", "X-LLM-API-Key": "k"},
        json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 400
    assert "Unknown LLM provider" in response.json()["detail"]


def test_external_provider_requires_api_key(client: TestClient) -> None:
    response = client.post(
        "/projects/x/chat",
        headers={"X-LLM-Provider": "perplexity"},
        json={"model": "sonar", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 400
    assert "X-LLM-API-Key" in response.json()["detail"]


@pytest.mark.parametrize("provider_value", ["perplexity", "deepseek"])
def test_new_providers_route_through_external_service(
    client: TestClient, provider_value: str
) -> None:
    """Perplexity and DeepSeek must construct an ExternalLLMService with that provider."""
    with patch(
        "app.routes.chat.routes.ExternalLLMService.stream_generate_messages",
        new=_fake_token_stream,
    ):
        response = client.post(
            "/projects/x/chat",
            headers={"X-LLM-Provider": provider_value, "X-LLM-API-Key": "k"},
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
        )
    assert response.status_code == 200
    body = response.text
    assert "hi" in body
    assert "[DONE]" in body


def test_new_providers_have_base_urls() -> None:
    """Both providers must be mapped to an OpenAI-compatible base URL."""
    assert _OPENAI_COMPATIBLE_BASE_URLS[LLMProvider.PERPLEXITY].startswith("https://")
    assert _OPENAI_COMPATIBLE_BASE_URLS[LLMProvider.DEEPSEEK].startswith("https://")


def test_plain_text_header_prepends_system_prompt(client: TestClient) -> None:
    """When X-Prefer-Plain-Text=1, the chat route must insert a system message
    instructing the model to respond without Markdown formatting."""
    captured: dict[str, Any] = {}

    async def _capture_stream(
        self: Any, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        captured["messages"] = messages
        captured["provider"] = self.provider
        yield "ok"

    with patch(
        "app.routes.chat.routes.ExternalLLMService.stream_generate_messages",
        new=_capture_stream,
    ):
        response = client.post(
            "/projects/x/chat",
            headers={
                "X-LLM-Provider": "anthropic",
                "X-LLM-API-Key": "k",
                "X-Prefer-Plain-Text": "1",
            },
            json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert response.status_code == 200
    msgs = captured["messages"]
    assert msgs[0]["role"] == "system"
    assert "Markdown" in msgs[0]["content"]
    assert msgs[1] == {"role": "user", "content": "hi"}
    assert captured["provider"] == LLMProvider.ANTHROPIC


def test_anthropic_extracts_system_prompt_into_kwargs() -> None:
    """Anthropic's API takes `system` as a top-level kwarg, not a message.
    The provider implementation must lift any system role out of the messages
    list. This test inspects the kwargs constructed before streaming."""
    import anthropic

    from app.llm_service import ExternalLLMService

    svc = ExternalLLMService(
        provider=LLMProvider.ANTHROPIC,
        api_key="k",
        model="claude-sonnet-4-5",
    )

    captured_kwargs: dict[str, Any] = {}

    class _FakeStreamCtx:
        async def __aenter__(self) -> _FakeStreamCtx:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        @property
        def text_stream(self) -> AsyncGenerator[str, None]:
            async def _gen() -> AsyncGenerator[str, None]:
                yield "ok"

            return _gen()

    class _FakeMessages:
        def stream(self, **kwargs: Any) -> _FakeStreamCtx:
            captured_kwargs.update(kwargs)
            return _FakeStreamCtx()

    class _FakeClient:
        def __init__(self, **_: Any) -> None:
            self.messages = _FakeMessages()

    import asyncio

    with patch.object(anthropic, "AsyncAnthropic", _FakeClient):

        async def _drain() -> list[str]:
            return [
                token
                async for token in svc._stream_anthropic(
                    [
                        {"role": "system", "content": "plain text only"},
                        {"role": "user", "content": "hi"},
                    ]
                )
            ]

        tokens = asyncio.run(_drain())

    assert tokens == ["ok"]
    assert captured_kwargs["system"] == "plain text only"
    # System must NOT remain in the messages array sent to Anthropic.
    assert all(m["role"] != "system" for m in captured_kwargs["messages"])
    assert captured_kwargs["messages"] == [{"role": "user", "content": "hi"}]


def test_chat_mentions_inject_source_context(client: TestClient) -> None:
    """When X-Chat-Mentions is set, chunks of the mentioned source are
    concatenated, ordered by chunk_index, and injected as a system message."""
    captured: dict[str, list[dict[str, Any]]] = {}

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured["messages"] = messages
        yield "ok"

    fake_collection_result: dict[str, Any] = {
        "ids": ["paper-a__chunk_0001", "paper-a__chunk_0000"],
        "documents": ["second part", "first part"],
        "metadatas": [
            {
                "chunk_index": 1,
                "source_filename": "paper-a.pdf",
                "source_type": "pdf",
                "source_stem": "paper-a",
            },
            {
                "chunk_index": 0,
                "source_filename": "paper-a.pdf",
                "source_type": "pdf",
                "source_stem": "paper-a",
            },
        ],
    }

    class _FakeCollection:
        def get(self, **_kwargs: Any) -> dict[str, Any]:
            return fake_collection_result

    with (
        patch("app.routes.chat.context.get_collection", return_value=_FakeCollection()),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages",
            new=_capture,
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "paper-a"},
            json={"model": "llama3", "messages": [{"role": "user", "content": "résume"}]},
        )

    assert response.status_code == 200
    messages = captured["messages"]
    assert messages[0]["role"] == "system"
    body = messages[0]["content"]
    assert "DÉBUT DU CONTENU : paper-a.pdf" in body
    assert "FIN DU CONTENU : paper-a.pdf" in body
    assert body.index("first part") < body.index("second part")
    assert messages[-1] == {"role": "user", "content": "résume"}


def test_chat_mentions_reject_excessive_count(client: TestClient) -> None:
    """Requests with more than MENTION_MAX_COUNT mentions are rejected up-front
    so the backend cannot be coerced into N sequential Chroma reads."""
    from app.routes.chat import MENTION_MAX_COUNT

    stems = ",".join(f"s{i}" for i in range(MENTION_MAX_COUNT + 1))
    response = client.post(
        "/projects/p1/chat",
        headers={"X-Chat-Mentions": stems},
        json={"model": "llama3", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 400
    assert "Too many mentions" in response.json()["detail"]


def test_chat_mentions_total_payload_capped(client: TestClient) -> None:
    """When concatenated chunks exceed MENTION_TOTAL_CHAR_CAP, the injected
    system message is truncated with a clear marker."""
    from app.routes.chat import MENTION_CONTENT_CHAR_CAP, MENTION_TOTAL_CHAR_CAP

    captured: dict[str, list[dict[str, Any]]] = {}

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured["messages"] = messages
        yield "ok"

    # Each source returns MENTION_CONTENT_CHAR_CAP chars; with 5 sources the
    # joined total exceeds MENTION_TOTAL_CHAR_CAP and must be truncated.
    big_doc = "x" * MENTION_CONTENT_CHAR_CAP
    stem_list = [f"s{i}" for i in range(5)]
    fake_result: dict[str, Any] = {
        "ids": [f"c{i}" for i in range(5)],
        "documents": [big_doc] * 5,
        "metadatas": [
            {
                "chunk_index": 0,
                "source_filename": f"{s}.pdf",
                "source_type": "pdf",
                "source_stem": s,
            }
            for s in stem_list
        ],
    }

    class _FakeCollection:
        def get(self, **_kwargs: Any) -> dict[str, Any]:
            return fake_result

    stems = ",".join(stem_list)
    with (
        patch("app.routes.chat.context.get_collection", return_value=_FakeCollection()),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages",
            new=_capture,
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": stems},
            json={"model": "llama3", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert response.status_code == 200
    system_content = captured["messages"][0]["content"]
    assert "[contexte mentionné tronqué]" in system_content
    # The total payload (header + truncated body) stays close to the cap.
    assert len(system_content) < MENTION_TOTAL_CHAR_CAP + 500


def test_chat_mentions_silent_when_no_match(client: TestClient) -> None:
    """An X-Chat-Mentions header referencing an unknown stem must not crash
    and must not inject a system message."""
    captured: dict[str, list[dict[str, Any]]] = {}

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured["messages"] = messages
        yield "ok"

    class _EmptyCollection:
        def get(self, **_kwargs: Any) -> dict[str, Any]:
            return {"ids": [], "documents": [], "metadatas": []}

    with (
        patch("app.routes.chat.context.get_collection", return_value=_EmptyCollection()),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages",
            new=_capture,
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "missing"},
            json={"model": "llama3", "messages": [{"role": "user", "content": "ping"}]},
        )

    assert response.status_code == 200
    assert captured["messages"] == [{"role": "user", "content": "ping"}]
