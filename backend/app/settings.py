"""Two-layer application settings: global defaults + per-project overrides.

Three knobs that the backend must know to shape ingestion are persisted on
disk (not in the browser like the LLM provider/keys):

- ``embed_model``        — Ollama embedding model used to index a project.
- ``chunk_granularity``  — how finely documents are split (chunk size).
- ``auto_enrich``        — whether the abstract + categories are generated
  automatically after indexing.

Storage:
- Global defaults  → ``<DATA_DIR>/settings.json``
- Per-project      → ``<DATA_DIR>/projects/<id>/settings.json`` (nullable
  fields; a null field inherits the global default).

The effective value for a project is ``project override ?? global default``.
"""

from __future__ import annotations

import json
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.config import DATA_DIR, OLLAMA_EMBED_MODEL, PROJECTS_DIR


class ChunkGranularity(StrEnum):
    PRECIS = "precis"
    EQUILIBRE = "equilibre"
    RAPIDE = "rapide"


# Per-chunk character cap for each granularity. Higher = fewer/larger chunks
# (faster indexing) but needs an embedding model with a larger context window;
# lower = finer-grained retrieval. Consumed by app.ingestion.chunk_text.
#
# RAPIDE (4000) can exceed the ~2048-token window of the default
# `nomic-embed-text` model (see config.MAX_CHUNK_CHARS). When it does, the
# ingestion layer re-splits the offending chunks on the fly
# (app.ingestion._resplit_oversized_chunk) instead of failing the document —
# so RAPIDE stays correct with any embed model, just less efficient on a
# small-context one.
_GRANULARITY_CHARS: dict[ChunkGranularity, int] = {
    ChunkGranularity.PRECIS: 1200,
    ChunkGranularity.EQUILIBRE: 2000,
    ChunkGranularity.RAPIDE: 4000,
}


def granularity_to_chars(granularity: ChunkGranularity) -> int:
    return _GRANULARITY_CHARS[granularity]


class AppSettings(BaseModel):
    """Global defaults — every field always has a concrete value."""

    embed_model: str = OLLAMA_EMBED_MODEL
    chunk_granularity: ChunkGranularity = ChunkGranularity.EQUILIBRE
    auto_enrich: bool = True


class ProjectSettings(BaseModel):
    """Per-project overrides — a null field inherits the global default."""

    embed_model: str | None = None
    chunk_granularity: ChunkGranularity | None = None
    auto_enrich: bool | None = None


class ResolvedSettings(BaseModel):
    """Effective settings for a project: project override ?? global default."""

    embed_model: str
    chunk_granularity: ChunkGranularity
    max_chunk_chars: int
    auto_enrich: bool


_SETTINGS_FILENAME = "settings.json"


def _global_path() -> Path:
    return DATA_DIR / _SETTINGS_FILENAME


def _project_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / _SETTINGS_FILENAME


def _load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def read_global_settings() -> AppSettings:
    try:
        return AppSettings(**_load(_global_path()))
    except Exception:
        return AppSettings()


def write_global_settings(settings: AppSettings) -> AppSettings:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _global_path().write_text(
        json.dumps(settings.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return settings


def read_project_settings(project_id: str) -> ProjectSettings:
    try:
        return ProjectSettings(**_load(_project_path(project_id)))
    except Exception:
        return ProjectSettings()


def write_project_settings(project_id: str, settings: ProjectSettings) -> ProjectSettings:
    path = _project_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(settings.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return settings


def resolve_settings(project_id: str) -> ResolvedSettings:
    """Merge the per-project overrides over the global defaults."""
    g = read_global_settings()
    p = read_project_settings(project_id)
    granularity = p.chunk_granularity or g.chunk_granularity
    return ResolvedSettings(
        # `or` is fine for embed_model: an empty-string override is meaningless
        # and should fall back to the global default just like None.
        embed_model=p.embed_model or g.embed_model,
        chunk_granularity=granularity,
        max_chunk_chars=granularity_to_chars(granularity),
        # auto_enrich must use `is not None` — False is a valid override.
        auto_enrich=p.auto_enrich if p.auto_enrich is not None else g.auto_enrich,
    )


__all__ = [
    "AppSettings",
    "ChunkGranularity",
    "ProjectSettings",
    "ResolvedSettings",
    "granularity_to_chars",
    "read_global_settings",
    "read_project_settings",
    "resolve_settings",
    "write_global_settings",
    "write_project_settings",
]
