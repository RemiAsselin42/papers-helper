from __future__ import annotations

from typing import Any

import chromadb
from chromadb.errors import NotFoundError

from app.config import PROJECTS_DIR
from app.ollama_service import get_embed_fn

COLLECTION_NAME = "papers"
_EMBED_MODEL_META_KEY = "embed_model"

_cache: dict[str, tuple[Any, chromadb.Collection]] = {}


def get_collection(project_id: str) -> chromadb.Collection:
    if project_id in _cache:
        return _cache[project_id][1]

    vectors_dir = PROJECTS_DIR / project_id / "vectors"
    vectors_dir.mkdir(parents=True, exist_ok=True)
    client = chromadb.PersistentClient(path=str(vectors_dir))
    fn = get_embed_fn()
    current_model = fn.model

    try:
        existing = client.get_collection(COLLECTION_NAME)
        stored = (existing.metadata or {}).get(_EMBED_MODEL_META_KEY, "")
        if stored != current_model:
            # Incompatible embedding space (or legacy collection without tag) —
            # drop and let get_or_create recreate it.
            client.delete_collection(COLLECTION_NAME)
    except NotFoundError:
        pass  # Collection doesn't exist yet

    collection = client.get_or_create_collection(
        COLLECTION_NAME,
        embedding_function=fn,  # type: ignore[arg-type]
        metadata={_EMBED_MODEL_META_KEY: current_model},
    )
    _cache[project_id] = (client, collection)
    return collection


def evict_collection(project_id: str) -> None:
    entry = _cache.pop(project_id, None)
    if entry is None:
        return
    client, _ = entry
    try:
        # Explicitly stop the internal system to close the SQLite connection
        # before the caller attempts shutil.rmtree on Windows.
        client._system.stop()
    except Exception:
        pass
