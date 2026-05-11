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
