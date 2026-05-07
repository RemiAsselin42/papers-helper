from __future__ import annotations

from collections.abc import AsyncGenerator
from enum import Enum
from typing import Any


class LLMProvider(str, Enum):
    OLLAMA = "ollama"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"


class ExternalLLMService:
    def __init__(self, provider: LLMProvider, api_key: str, model: str) -> None:
        self.provider = provider
        self.api_key = api_key
        self.model = model

    async def stream_generate_messages(
        self, messages: list[dict[str, Any]]
    ) -> AsyncGenerator[str, None]:
        if self.provider in (LLMProvider.OPENAI, LLMProvider.GEMINI):
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
        if self.provider == LLMProvider.GEMINI:
            kwargs["base_url"] = "https://generativelanguage.googleapis.com/v1beta/openai/"

        client = AsyncOpenAI(**kwargs)
        stream = await client.chat.completions.create(
            model=self.model,
            messages=messages,  # type: ignore[arg-type]
            stream=True,
        )
        async for chunk in stream:
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
