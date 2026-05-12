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
        "app.routes.chat.ExternalLLMService.stream_generate_messages",
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
        "app.routes.chat.ExternalLLMService.stream_generate_messages",
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
