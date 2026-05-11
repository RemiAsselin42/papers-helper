"""Tests for embedding provider routing and Chroma collection rebuild on switch."""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import set_request_embed_config
from app.embeddings import (
    DEFAULT_EMBED_MODELS,
    EmbedConfig,
    EmbedProvider,
    build_embed_fn,
    resolve_embed_config,
)
from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


# ─── resolve_embed_config ──────────────────────────────────────────────────────


def test_resolve_unknown_provider_falls_back_to_ollama() -> None:
    cfg = resolve_embed_config("anthropic", "sk-xxx")
    assert cfg.provider == EmbedProvider.OLLAMA


@pytest.mark.parametrize("provider", ["perplexity", "deepseek", "anthropic"])
def test_resolve_embedless_providers_fall_back(provider: str) -> None:
    cfg = resolve_embed_config(provider, "sk-xxx")
    assert cfg.provider == EmbedProvider.OLLAMA


def test_resolve_openai_with_key() -> None:
    cfg = resolve_embed_config("openai", "sk-xxx")
    assert cfg.provider == EmbedProvider.OPENAI
    assert cfg.api_key == "sk-xxx"
    assert cfg.model == DEFAULT_EMBED_MODELS[EmbedProvider.OPENAI]


def test_resolve_gemini_with_key() -> None:
    cfg = resolve_embed_config("gemini", "gemini-key")
    assert cfg.provider == EmbedProvider.GEMINI
    assert cfg.api_key == "gemini-key"


def test_resolve_external_without_key_falls_back_to_ollama() -> None:
    cfg = resolve_embed_config("openai", None)
    assert cfg.provider == EmbedProvider.OLLAMA
    assert cfg.api_key is None


def test_resolve_none_provider_uses_ollama() -> None:
    cfg = resolve_embed_config(None, None)
    assert cfg.provider == EmbedProvider.OLLAMA


# ─── build_embed_fn ────────────────────────────────────────────────────────────


def test_build_ollama_fn() -> None:
    cfg = resolve_embed_config(None, None)
    fn = build_embed_fn(cfg)
    # Smoke check: this should at least construct without raising.
    assert hasattr(fn, "__call__")


def test_build_openai_fn() -> None:
    cfg = EmbedConfig(
        provider=EmbedProvider.OPENAI,
        model="text-embedding-3-small",
        api_key="sk-test",
        ollama_url=None,
    )
    with patch("openai.OpenAI") as mock_openai:
        fn = build_embed_fn(cfg)
    assert mock_openai.called
    # Default base_url (no override for OpenAI itself)
    call_kwargs = mock_openai.call_args.kwargs
    assert call_kwargs["api_key"] == "sk-test"
    assert "base_url" not in call_kwargs
    assert fn.model == "text-embedding-3-small"  # type: ignore[attr-defined]


def test_build_gemini_fn_uses_openai_compat_base_url() -> None:
    cfg = EmbedConfig(
        provider=EmbedProvider.GEMINI,
        model="text-embedding-004",
        api_key="gem-key",
        ollama_url=None,
    )
    with patch("openai.OpenAI") as mock_openai:
        build_embed_fn(cfg)
    call_kwargs = mock_openai.call_args.kwargs
    assert call_kwargs["api_key"] == "gem-key"
    assert "generativelanguage.googleapis.com" in call_kwargs["base_url"]


# ─── chroma get_collection rebuilds on provider/model change ───────────────────


def test_get_collection_drops_when_provider_changes(tmp_path: Path) -> None:
    """If a project's stored embed_provider differs from the requested one,
    the collection is dropped so a fresh one with the right dimensions is created."""
    from app import chroma

    project_id = "proj-xyz"

    # Build a fake Chroma client with one existing collection that says
    # 'provider=ollama'.
    fake_client = MagicMock()
    existing = MagicMock()
    existing.metadata = {"embed_provider": "ollama", "embed_model": "nomic-embed-text"}
    fake_client.get_collection.return_value = existing
    fake_collection = MagicMock()
    fake_client.get_or_create_collection.return_value = fake_collection

    chroma._client_cache[project_id] = fake_client

    # Request comes in with OpenAI embed config.
    set_request_embed_config(
        EmbedConfig(
            provider=EmbedProvider.OPENAI,
            model="text-embedding-3-small",
            api_key="sk-test",
            ollama_url=None,
        )
    )

    try:
        with patch("openai.OpenAI"):
            result = chroma.get_collection(project_id)
    finally:
        chroma._client_cache.pop(project_id, None)
        set_request_embed_config(None)

    fake_client.delete_collection.assert_called_once_with(chroma.COLLECTION_NAME)
    fake_client.get_or_create_collection.assert_called_once()
    call_kwargs: dict[str, Any] = fake_client.get_or_create_collection.call_args.kwargs
    assert call_kwargs["metadata"]["embed_provider"] == "openai"
    assert call_kwargs["metadata"]["embed_model"] == "text-embedding-3-small"
    assert result is fake_collection


def test_get_collection_keeps_when_provider_matches(tmp_path: Path) -> None:
    from app import chroma

    project_id = "proj-keep"

    fake_client = MagicMock()
    existing = MagicMock()
    existing.metadata = {"embed_provider": "openai", "embed_model": "text-embedding-3-small"}
    fake_client.get_collection.return_value = existing
    fake_collection = MagicMock()
    fake_client.get_or_create_collection.return_value = fake_collection

    chroma._client_cache[project_id] = fake_client

    set_request_embed_config(
        EmbedConfig(
            provider=EmbedProvider.OPENAI,
            model="text-embedding-3-small",
            api_key="sk-test",
            ollama_url=None,
        )
    )

    try:
        with patch("openai.OpenAI"):
            chroma.get_collection(project_id)
    finally:
        chroma._client_cache.pop(project_id, None)
        set_request_embed_config(None)

    fake_client.delete_collection.assert_not_called()
    fake_client.get_or_create_collection.assert_called_once()


# ─── middleware integration: headers populate the embed config ─────────────────


def test_middleware_resolves_embed_config_from_headers(client: TestClient) -> None:
    """A request with X-LLM-Provider=openai and a key sets a request-scoped OpenAI config."""
    captured: dict[str, Any] = {}

    from app import config

    real_setter = config.set_request_embed_config

    def capture(cfg: Any) -> None:
        if cfg is not None:
            captured["cfg"] = cfg
        real_setter(cfg)

    with patch("app.main.set_request_embed_config", side_effect=capture):
        client.get("/health", headers={"X-LLM-Provider": "openai", "X-LLM-API-Key": "sk-test"})

    cfg = captured["cfg"]
    assert cfg.provider == EmbedProvider.OPENAI
    assert cfg.api_key == "sk-test"


def test_middleware_falls_back_when_no_headers(client: TestClient) -> None:
    captured: dict[str, Any] = {}

    from app import config

    real_setter = config.set_request_embed_config

    def capture(cfg: Any) -> None:
        if cfg is not None:
            captured["cfg"] = cfg
        real_setter(cfg)

    with patch("app.main.set_request_embed_config", side_effect=capture):
        client.get("/health")

    cfg = captured["cfg"]
    assert cfg.provider == EmbedProvider.OLLAMA
    assert cfg.api_key is None
