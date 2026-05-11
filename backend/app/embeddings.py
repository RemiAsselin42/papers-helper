from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import cast

from chromadb import Documents, EmbeddingFunction, Embeddings

from app.config import OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, get_ollama_url
from app.ollama_service import OllamaEmbeddingFunction


class EmbedProvider(StrEnum):
    OLLAMA = "ollama"
    OPENAI = "openai"
    GEMINI = "gemini"


DEFAULT_EMBED_MODELS: dict[EmbedProvider, str] = {
    EmbedProvider.OLLAMA: OLLAMA_EMBED_MODEL,
    EmbedProvider.OPENAI: "text-embedding-3-small",
    EmbedProvider.GEMINI: "text-embedding-004",
}


# LLM chat providers that also expose an embeddings API.
_LLM_TO_EMBED: dict[str, EmbedProvider] = {
    "ollama": EmbedProvider.OLLAMA,
    "openai": EmbedProvider.OPENAI,
    "gemini": EmbedProvider.GEMINI,
}


@dataclass(frozen=True)
class EmbedConfig:
    """Resolved embedding configuration for a single request.

    `api_key` is None for Ollama. For external providers it must be set.
    """

    provider: EmbedProvider
    model: str
    api_key: str | None
    ollama_url: str | None  # only relevant when provider == OLLAMA


class OpenAIEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, api_key: str, model: str) -> None:
        from openai import OpenAI

        self.model = model
        self._client = OpenAI(api_key=api_key)

    def __call__(self, input: Documents) -> Embeddings:
        resp = self._client.embeddings.create(model=self.model, input=list(input))
        return cast(Embeddings, [d.embedding for d in resp.data])


class GeminiEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, api_key: str, model: str) -> None:
        from openai import OpenAI

        self.model = model
        self._client = OpenAI(
            api_key=api_key,
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        )

    def __call__(self, input: Documents) -> Embeddings:
        resp = self._client.embeddings.create(model=self.model, input=list(input))
        return cast(Embeddings, [d.embedding for d in resp.data])


def resolve_embed_config(
    llm_provider: str | None,
    llm_api_key: str | None,
) -> EmbedConfig:
    """Pick an embedding provider based on the chat LLM provider.

    LLM providers that ship native embeddings (Ollama, OpenAI, Gemini) use their
    own. Providers without embeddings (Anthropic, Perplexity, DeepSeek) fall back
    to Ollama. A missing API key for an external provider also falls back to
    Ollama so ingestion can still succeed locally.
    """
    embed_provider = _LLM_TO_EMBED.get(llm_provider or "", EmbedProvider.OLLAMA)
    if embed_provider != EmbedProvider.OLLAMA and not llm_api_key:
        embed_provider = EmbedProvider.OLLAMA

    if embed_provider == EmbedProvider.OLLAMA:
        return EmbedConfig(
            provider=EmbedProvider.OLLAMA,
            model=DEFAULT_EMBED_MODELS[EmbedProvider.OLLAMA],
            api_key=None,
            ollama_url=get_ollama_url(),
        )

    assert llm_api_key is not None
    return EmbedConfig(
        provider=embed_provider,
        model=DEFAULT_EMBED_MODELS[embed_provider],
        api_key=llm_api_key,
        ollama_url=None,
    )


def build_embed_fn(config: EmbedConfig) -> EmbeddingFunction[Documents]:
    if config.provider == EmbedProvider.OLLAMA:
        return OllamaEmbeddingFunction(
            model=config.model,
            base_url=config.ollama_url or OLLAMA_BASE_URL,
        )
    if config.provider == EmbedProvider.OPENAI:
        assert config.api_key is not None
        return OpenAIEmbeddingFunction(api_key=config.api_key, model=config.model)
    if config.provider == EmbedProvider.GEMINI:
        assert config.api_key is not None
        return GeminiEmbeddingFunction(api_key=config.api_key, model=config.model)
    raise ValueError(f"Unsupported embed provider: {config.provider}")
