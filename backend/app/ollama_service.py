from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import ollama
from chromadb import Documents, EmbeddingFunction, Embeddings

from app.config import OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL, get_ollama_url

# Most Ollama embedding models (nomic-embed-text, mxbai-embed-large, bge-large)
# support 8192-token context, but Ollama's per-request default is 2048. Bumping
# this avoids 400 "input length exceeds context length" errors on dense chunks.
# Ollama silently clamps to the model's actual maximum.
_EMBED_NUM_CTX = 8192


class OllamaEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, model: str = OLLAMA_EMBED_MODEL, base_url: str = OLLAMA_BASE_URL) -> None:
        self.model = model
        self._client = ollama.Client(host=base_url)

    def __call__(self, input: Documents) -> Embeddings:
        return self._client.embed(  # type: ignore[return-value]
            model=self.model,
            input=input,
            options={"num_ctx": _EMBED_NUM_CTX},
        ).embeddings


class OllamaGenerationService:
    def __init__(
        self,
        model: str = OLLAMA_GENERATION_MODEL,
        base_url: str | None = None,
    ) -> None:
        self.model = model
        effective_url = base_url if base_url is not None else get_ollama_url()
        self._client = ollama.AsyncClient(host=effective_url)

    async def generate(self, prompt: str, system: str = "") -> str:
        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        response = await self._client.chat(model=self.model, messages=messages)
        return response.message.content  # type: ignore[return-value]

    async def stream_generate(self, prompt: str, system: str = "") -> AsyncGenerator[str, None]:
        messages: list[dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        async for chunk in await self._client.chat(
            model=self.model, messages=messages, stream=True
        ):
            if chunk.message.content:
                yield chunk.message.content

    async def stream_generate_messages(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        async for chunk in await self._client.chat(
            model=self.model, messages=messages, stream=True
        ):
            if chunk.message.content:
                yield chunk.message.content


