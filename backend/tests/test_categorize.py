"""Tests for the /categorize endpoint — one-shot LLM categorisation.

/categorize derives category labels from a document's abstract in a single LLM
call (no Chroma read, no map-reduce). It stays a thin wrapper over
`condense.run_single_generation`.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


def test_categorize_rejects_empty_prompt(client: TestClient) -> None:
    resp = client.post(
        "/projects/p/categorize",
        json={"prompt": "  ", "text": "abc", "model": "llama3"},
    )
    assert resp.status_code == 400
    assert "prompt" in resp.json()["detail"]


def test_categorize_rejects_empty_text(client: TestClient) -> None:
    resp = client.post(
        "/projects/p/categorize",
        json={"prompt": "classe", "text": "   ", "model": "llama3"},
    )
    assert resp.status_code == 400
    assert "text" in resp.json()["detail"]


def test_categorize_rejects_unknown_provider(client: TestClient) -> None:
    resp = client.post(
        "/projects/p/categorize",
        headers={"X-LLM-Provider": "bogus", "X-LLM-API-Key": "k"},
        json={"prompt": "classe", "text": "abc", "model": "m"},
    )
    assert resp.status_code == 400


def test_categorize_external_provider_requires_api_key(client: TestClient) -> None:
    resp = client.post(
        "/projects/p/categorize",
        headers={"X-LLM-Provider": "anthropic"},
        json={"prompt": "classe", "text": "abc", "model": "claude"},
    )
    assert resp.status_code == 400
    assert "X-LLM-API-Key" in resp.json()["detail"]


def test_categorize_returns_llm_text(client: TestClient) -> None:
    """A healthy run forwards prompt + abstract to the model and returns the
    full collected output verbatim for the frontend to parse."""
    captured: list[list[dict[str, Any]]] = []

    async def _fake_gen(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured.append(messages)
        yield '["Socio'
        yield 'logie"]'

    with patch(
        "app.ollama_service.OllamaGenerationService.stream_generate_messages",
        new=_fake_gen,
    ):
        resp = client.post(
            "/projects/p/categorize",
            json={
                "prompt": "Classe ce résumé.",
                "text": "Un résumé du document.",
                "model": "llama3",
            },
        )

    assert resp.status_code == 200
    assert resp.json()["text"] == '["Sociologie"]'
    body = captured[0][0]["content"]
    assert "Classe ce résumé." in body
    assert "Un résumé du document." in body
