from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import ollama
from chromadb import Documents, EmbeddingFunction, Embeddings

from app.config import OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL


class OllamaEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, model: str = OLLAMA_EMBED_MODEL, base_url: str = OLLAMA_BASE_URL) -> None:
        self.model = model
        self._client = ollama.Client(host=base_url)

    def __call__(self, input: Documents) -> Embeddings:
        return self._client.embed(model=self.model, input=input).embeddings  # type: ignore[return-value]


class OllamaGenerationService:
    def __init__(
        self,
        model: str = OLLAMA_GENERATION_MODEL,
        base_url: str = OLLAMA_BASE_URL,
    ) -> None:
        self.model = model
        self._client = ollama.AsyncClient(host=base_url)

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


embed_fn = OllamaEmbeddingFunction()
