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

# /condense endpoint sizing. The map step fans out to Ollama; concurrency above
# 2 thrashes a single GPU more than it parallelises. The full-doc threshold is
# expressed as a fraction of the provider's context limit to leave room for the
# system prompt + the response. The token-per-chunk estimate assumes the ~500
# words/chunk target from ingestion.py × 1.3 tokens/word for English/French.
# Keep CONDENSE_TOKENS_PER_CHUNK_ESTIMATE in sync with `target_words` in
# `app.ingestion.chunk_text` (currently 500); if the chunker is retuned, the
# full-doc strategy threshold drifts silently.
CONDENSE_MAP_MAX_CONCURRENCY: int = int(os.getenv("CONDENSE_MAP_MAX_CONCURRENCY", "2"))
CONDENSE_FULL_DOC_CONTEXT_RATIO: float = float(os.getenv("CONDENSE_FULL_DOC_CONTEXT_RATIO", "0.7"))
CONDENSE_TOKENS_PER_CHUNK_ESTIMATE: int = int(
    os.getenv("CONDENSE_TOKENS_PER_CHUNK_ESTIMATE", "650")
)
CONDENSE_MAX_STEMS: int = int(os.getenv("CONDENSE_MAX_STEMS", "20"))

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
