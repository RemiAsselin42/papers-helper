from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock

# Stub the ollama package before app.* is imported.
# The real ollama client blocks on import while trying to connect to a daemon.
_ollama = types.ModuleType("ollama")

# Health check (sync)
_ollama.list = MagicMock(return_value=MagicMock(models=[]))  # type: ignore[attr-defined]

# Sync client used by OllamaEmbeddingFunction
_sync_client = MagicMock()
_sync_client.embed.return_value = MagicMock(embeddings=[[0.1, 0.2, 0.3]])
_ollama.Client = MagicMock(return_value=_sync_client)  # type: ignore[attr-defined]

# Async client used by OllamaGenerationService
_async_client = MagicMock()
_async_client.chat = AsyncMock(return_value=MagicMock(message=MagicMock(content="mocked")))
_ollama.AsyncClient = MagicMock(return_value=_async_client)  # type: ignore[attr-defined]

sys.modules.setdefault("ollama", _ollama)
