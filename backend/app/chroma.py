from __future__ import annotations

from typing import Any

import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

from app.config import PROJECTS_DIR

COLLECTION_NAME = "papers"

_cache: dict[str, tuple[Any, chromadb.Collection]] = {}


def get_collection(project_id: str) -> chromadb.Collection:
    if project_id not in _cache:
        vectors_dir = PROJECTS_DIR / project_id / "vectors"
        vectors_dir.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(vectors_dir))
        collection = client.get_or_create_collection(
            COLLECTION_NAME,
            embedding_function=DefaultEmbeddingFunction(),  # type: ignore[arg-type]
        )
        _cache[project_id] = (client, collection)
    return _cache[project_id][1]


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
