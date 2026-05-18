"""Tests for the two-layer settings: global defaults + per-project overrides."""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import settings as settings_mod
from app.main import app
from app.settings import (
    AppSettings,
    ChunkGranularity,
    ProjectSettings,
    granularity_to_chars,
    read_global_settings,
    resolve_settings,
    write_global_settings,
    write_project_settings,
)


@pytest.fixture
def data_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Redirect every settings path (module + route) into a tmp data dir."""
    projects = tmp_path / "projects"
    projects.mkdir()
    with (
        patch.object(settings_mod, "DATA_DIR", tmp_path),
        patch.object(settings_mod, "PROJECTS_DIR", projects),
        patch("app.routes.settings.PROJECTS_DIR", projects),
    ):
        yield tmp_path


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# resolve_settings — inheritance
# ---------------------------------------------------------------------------


def test_granularity_chars_are_ordered() -> None:
    assert (
        granularity_to_chars(ChunkGranularity.PRECIS)
        < granularity_to_chars(ChunkGranularity.EQUILIBRE)
        < granularity_to_chars(ChunkGranularity.RAPIDE)
    )


def test_defaults_when_nothing_persisted(data_dir: Path) -> None:
    s = read_global_settings()
    assert s.chunk_granularity == ChunkGranularity.EQUILIBRE
    assert s.auto_enrich is True


def test_resolve_uses_global_when_no_project_override(data_dir: Path) -> None:
    write_global_settings(
        AppSettings(
            embed_model="bge-m3",
            chunk_granularity=ChunkGranularity.RAPIDE,
            auto_enrich=False,
        )
    )
    r = resolve_settings("proj-x")
    assert r.embed_model == "bge-m3"
    assert r.chunk_granularity == ChunkGranularity.RAPIDE
    assert r.auto_enrich is False
    assert r.max_chunk_chars == granularity_to_chars(ChunkGranularity.RAPIDE)


def test_project_override_wins_over_global(data_dir: Path) -> None:
    write_global_settings(AppSettings(embed_model="nomic-embed-text", auto_enrich=True))
    write_project_settings("proj-x", ProjectSettings(embed_model="bge-m3", auto_enrich=False))
    r = resolve_settings("proj-x")
    assert r.embed_model == "bge-m3"
    assert r.auto_enrich is False


def test_null_override_inherits_global(data_dir: Path) -> None:
    write_global_settings(
        AppSettings(embed_model="nomic-embed-text", chunk_granularity=ChunkGranularity.PRECIS)
    )
    write_project_settings("proj-x", ProjectSettings())  # every field None
    r = resolve_settings("proj-x")
    assert r.embed_model == "nomic-embed-text"
    assert r.chunk_granularity == ChunkGranularity.PRECIS


def test_auto_enrich_false_override_is_not_treated_as_inherit(data_dir: Path) -> None:
    # False is a valid override — the resolver uses `is not None`, not `or`.
    write_global_settings(AppSettings(auto_enrich=True))
    write_project_settings("proj-x", ProjectSettings(auto_enrich=False))
    assert resolve_settings("proj-x").auto_enrich is False


def test_global_settings_persist_to_disk(data_dir: Path) -> None:
    write_global_settings(AppSettings(embed_model="bge-m3"))
    on_disk = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
    assert on_disk["embed_model"] == "bge-m3"


def test_corrupt_settings_file_falls_back_to_defaults(data_dir: Path) -> None:
    (data_dir / "settings.json").write_text("{ not json", encoding="utf-8")
    assert read_global_settings().chunk_granularity == ChunkGranularity.EQUILIBRE


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def test_global_settings_get_and_put(client: TestClient, data_dir: Path) -> None:
    assert client.get("/settings").status_code == 200
    put = client.put(
        "/settings",
        json={"embed_model": "bge-m3", "chunk_granularity": "rapide", "auto_enrich": False},
    )
    assert put.status_code == 200
    assert put.json()["embed_model"] == "bge-m3"
    assert client.get("/settings").json()["chunk_granularity"] == "rapide"


def test_project_settings_bundle(client: TestClient, data_dir: Path) -> None:
    (data_dir / "projects" / "proj-1").mkdir(parents=True)
    resp = client.get("/projects/proj-1/settings")
    assert resp.status_code == 200
    assert set(resp.json()) == {"overrides", "global_defaults", "resolved"}

    put = client.put(
        "/projects/proj-1/settings",
        json={"embed_model": "bge-m3", "chunk_granularity": None, "auto_enrich": None},
    )
    assert put.status_code == 200
    body = put.json()
    assert body["overrides"]["embed_model"] == "bge-m3"
    assert body["resolved"]["embed_model"] == "bge-m3"


def test_project_settings_404_for_missing_project(client: TestClient, data_dir: Path) -> None:
    assert client.get("/projects/does-not-exist/settings").status_code == 404
    assert client.put("/projects/does-not-exist/settings", json={}).status_code == 404
