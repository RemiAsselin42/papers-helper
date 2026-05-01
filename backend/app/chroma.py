from __future__ import annotations

import os
from pathlib import Path

import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

COLLECTION_NAME = "papers"

_DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))
_VECTORS_DIR = _DATA_DIR / "vectors"

_client: chromadb.PersistentClient | None = None
_collection: chromadb.Collection | None = None


def get_collection() -> chromadb.Collection:
    global _client, _collection
    if _collection is None:
        _VECTORS_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(_VECTORS_DIR))
        _collection = _client.get_or_create_collection(
            COLLECTION_NAME,
            embedding_function=DefaultEmbeddingFunction(),
        )
    return _collection
