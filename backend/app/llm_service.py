from __future__ import annotations

from collections.abc import AsyncGenerator
from enum import StrEnum
from typing import Any


class LLMProvider(StrEnum):
    OLLAMA = "ollama"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    PERPLEXITY = "perplexity"
    DEEPSEEK = "deepseek"


_OPENAI_COMPATIBLE_BASE_URLS: dict[LLMProvider, str] = {
    LLMProvider.GEMINI: "https://generativelanguage.googleapis.com/v1beta/openai/",
    LLMProvider.PERPLEXITY: "https://api.perplexity.ai",
    LLMProvider.DEEPSEEK: "https://api.deepseek.com",
}


class ExternalLLMService:
    def __init__(self, provider: LLMProvider, api_key: str, model: str) -> None:
        self.provider = provider
        self.api_key = api_key
        self.model = model

    async def stream_generate_messages(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        if self.provider in (
            LLMProvider.OPENAI,
            LLMProvider.GEMINI,
            LLMProvider.PERPLEXITY,
            LLMProvider.DEEPSEEK,
        ):
            async for token in self._stream_openai_compatible(messages):
                yield token
        elif self.provider == LLMProvider.ANTHROPIC:
            async for token in self._stream_anthropic(messages):
                yield token

    async def _stream_openai_compatible(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        from openai import AsyncOpenAI

        kwargs: dict[str, Any] = {"api_key": self.api_key}
        base_url = _OPENAI_COMPATIBLE_BASE_URLS.get(self.provider)
        if base_url is not None:
            kwargs["base_url"] = base_url

        client = AsyncOpenAI(**kwargs)
        stream = await client.chat.completions.create(
            model=self.model,
            messages=messages,  # type: ignore[arg-type]
            stream=True,
        )
        async for chunk in stream:  # type: ignore[union-attr]
            token = chunk.choices[0].delta.content
            if token:
                yield token

    async def _stream_anthropic(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        import anthropic

        system = ""
        chat_messages: list[dict[str, Any]] = []
        for m in messages:
            if m["role"] == "system":
                system = m["content"]
            else:
                chat_messages.append(m)

        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        create_kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": 8096,
            "messages": chat_messages,
        }
        if system:
            create_kwargs["system"] = system

        async with client.messages.stream(**create_kwargs) as stream:
            async for text in stream.text_stream:
                yield text
