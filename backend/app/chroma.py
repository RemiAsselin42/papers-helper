from __future__ import annotations

from dataclasses import replace
from typing import Any

import chromadb
from chromadb.api.shared_system_client import SharedSystemClient
from chromadb.errors import NotFoundError

from app.config import (
    OLLAMA_BASE_URL,
    OLLAMA_EMBED_MODEL,
    PROJECTS_DIR,
    get_request_embed_config,
)
from app.embeddings import EmbedConfig, EmbedProvider, build_embed_fn
from app.settings import resolve_settings

COLLECTION_NAME = "papers"
_EMBED_MODEL_META_KEY = "embed_model"
_EMBED_PROVIDER_META_KEY = "embed_provider"

# Chroma's PersistentClient() factory returns an instance whose concrete type
# isn't directly exposed as a Type — store as Any to avoid mypy noise.
_client_cache: dict[str, Any] = {}
# (project_id, provider, model) → (embed_fn, collection). Caching the embed
# function avoids constructing a new ollama.Client / OpenAI client on every
# request — important since embed_fn is held by the Chroma collection too.
_collection_cache: dict[tuple[str, str, str], tuple[Any, chromadb.Collection]] = {}


def _default_config() -> EmbedConfig:
    return EmbedConfig(
        provider=EmbedProvider.OLLAMA,
        model=OLLAMA_EMBED_MODEL,
        api_key=None,
        ollama_url=OLLAMA_BASE_URL,
    )


def _invalidate_project_collections(project_id: str) -> None:
    for key in list(_collection_cache):
        if key[0] == project_id:
            _collection_cache.pop(key, None)


def get_collection(project_id: str) -> chromadb.Collection:
    config = get_request_embed_config() or _default_config()
    # The embedding model is a per-project setting (project override ?? global
    # default). Only Ollama embeddings are user-selectable; external providers
    # keep the model resolved from their LLM provider. A model change flips the
    # cache key below → the existing drop+recreate path re-embeds on next ingest.
    if config.provider == EmbedProvider.OLLAMA:
        config = replace(config, model=resolve_settings(project_id).embed_model)
    cache_key = (project_id, config.provider.value, config.model)

    cached = _collection_cache.get(cache_key)
    if cached is not None:
        return cached[1]

    if project_id in _client_cache:
        client = _client_cache[project_id]
    else:
        vectors_dir = PROJECTS_DIR / project_id / "vectors"
        vectors_dir.mkdir(parents=True, exist_ok=True)
        client = chromadb.PersistentClient(path=str(vectors_dir))
        _client_cache[project_id] = client

    try:
        existing = client.get_collection(COLLECTION_NAME)
        meta = existing.metadata or {}
        stored_provider = meta.get(_EMBED_PROVIDER_META_KEY, EmbedProvider.OLLAMA.value)
        stored_model = meta.get(_EMBED_MODEL_META_KEY, "")
        if stored_provider != config.provider.value or stored_model != config.model:
            # Embedding space changed (provider or model) — drop and recreate so
            # the new function can re-embed on next ingestion.
            client.delete_collection(COLLECTION_NAME)
            _invalidate_project_collections(project_id)
    except NotFoundError:
        pass  # Collection doesn't exist yet

    embed_fn = build_embed_fn(config)
    collection: chromadb.Collection = client.get_or_create_collection(
        COLLECTION_NAME,
        embedding_function=embed_fn,
        metadata={
            _EMBED_PROVIDER_META_KEY: config.provider.value,
            _EMBED_MODEL_META_KEY: config.model,
        },
    )
    _collection_cache[cache_key] = (embed_fn, collection)
    return collection


def evict_collection(project_id: str) -> None:
    _invalidate_project_collections(project_id)
    client = _client_cache.pop(project_id, None)
    if client is None:
        return
    try:
        # Explicitly stop the internal system to close the SQLite connection
        # before the caller attempts shutil.rmtree on Windows.
        client._system.stop()
    except Exception:
        pass
    # Chroma keeps one System per persist-path in a process-wide registry and
    # does NOT drop it on stop(). Without clearing that registry, the next
    # PersistentClient for the same path reuses the *stopped* system and every
    # call fails with "Could not connect to tenant default_tenant" — which is
    # exactly what happens after a reindex (_stream_reindex evicts, then
    # rebuilds the client for the same project). Clearing forces a fresh,
    # running system on the next get_collection. Other projects' clients are
    # still served from `_client_cache`, so they keep working.
    try:
        SharedSystemClient.clear_system_cache()
    except Exception:
        pass
