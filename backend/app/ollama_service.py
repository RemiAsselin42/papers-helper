from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import ollama
from chromadb import Documents, EmbeddingFunction, Embeddings

from app.config import OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL, get_ollama_url

# Requested embedding context. NOTE: Ollama loads an embedding model at the
# context registered in its modelfile (~2048 for nomic-embed-text) and does
# NOT reliably honour a per-request num_ctx on /api/embed — so this is a
# best-effort hint, not a guarantee. The real safeguard against 400 "input
# length exceeds the context length" is the MAX_CHUNK_CHARS cap in ingestion.
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

    async def stream_generate_messages(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        async for chunk in await self._client.chat(
            model=self.model, messages=messages, stream=True
        ):
            if chunk.message.content:
                yield chunk.message.content
