"""Chat endpoint package.

Split into three modules to keep the route handler small and the context
retrieval testable in isolation:

- `routes`: the FastAPI endpoint, request models, header parsing
- `context`: problematique, mention RAG, global RAG block builders
- (env-backed caps live in `app.config` alongside the other knobs)

Public surface mirrors the pre-split single-file module so existing imports
(`from app.routes.chat import router, MENTION_MAX_COUNT`) still work.
"""

from app.routes.chat.context import (
    SHORT_DOC_CHUNK_THRESHOLD,
    _format_problematique_context,
    _retrieve_global_context,
    _retrieve_mention_context,
)
from app.routes.chat.routes import (
    MENTION_CONTENT_CHAR_CAP,
    MENTION_MAX_COUNT,
    MENTION_TOTAL_CHAR_CAP,
    PLAIN_TEXT_SYSTEM_PROMPT,
    ChatMessage,
    ChatRequest,
    chat,
    router,
)

__all__ = [
    "MENTION_CONTENT_CHAR_CAP",
    "MENTION_MAX_COUNT",
    "MENTION_TOTAL_CHAR_CAP",
    "PLAIN_TEXT_SYSTEM_PROMPT",
    "SHORT_DOC_CHUNK_THRESHOLD",
    "ChatMessage",
    "ChatRequest",
    "_format_problematique_context",
    "_retrieve_global_context",
    "_retrieve_mention_context",
    "chat",
    "router",
]
