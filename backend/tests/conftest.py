from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

# Stub the ollama package before app.main is imported.
# The real ollama client blocks on import while trying to connect to a daemon.
_ollama = types.ModuleType("ollama")
_ollama.list = MagicMock(return_value=MagicMock())  # type: ignore[attr-defined]
sys.modules.setdefault("ollama", _ollama)
