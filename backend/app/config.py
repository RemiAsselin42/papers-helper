import os
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.embeddings import EmbedConfig

DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))

PROJECTS_DIR = DATA_DIR / "projects"

OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_EMBED_MODEL: str = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
OLLAMA_GENERATION_MODEL: str = os.getenv("OLLAMA_GENERATION_MODEL", "llama3")

# Chat context-injection sizing. Defaults are tuned for ~8k-token small-context
# models (~32k chars). Larger Ollama setups can raise these via env vars to use
# more of the available window before per-turn truncation kicks in.
CHAT_MENTION_CONTENT_CHAR_CAP: int = int(os.getenv("CHAT_MENTION_CONTENT_CHAR_CAP", "20000"))
CHAT_MENTION_TOTAL_CHAR_CAP: int = int(os.getenv("CHAT_MENTION_TOTAL_CHAR_CAP", "60000"))
CHAT_K_PER_MENTION: int = int(os.getenv("CHAT_K_PER_MENTION", "5"))
CHAT_GLOBAL_RAG_K: int = int(os.getenv("CHAT_GLOBAL_RAG_K", "6"))

_request_ollama_url: ContextVar[str] = ContextVar("_request_ollama_url", default=OLLAMA_BASE_URL)
_request_embed_config: ContextVar["EmbedConfig | None"] = ContextVar(
    "_request_embed_config", default=None
)


def get_ollama_url() -> str:
    return _request_ollama_url.get()


def set_request_ollama_url(url: str) -> None:
    _request_ollama_url.set(url)


def get_request_embed_config() -> "EmbedConfig | None":
    return _request_embed_config.get()


def set_request_embed_config(config: "EmbedConfig | None") -> None:
    _request_embed_config.set(config)
