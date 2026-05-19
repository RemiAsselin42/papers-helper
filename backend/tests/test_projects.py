"""Tests pour le renommage d'un projet (PATCH /projects/{id})."""

from __future__ import annotations

import json
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@contextmanager
def _projects_dir(path: Path) -> Generator[None, None, None]:
    with patch("app.routes.projects.PROJECTS_DIR", path):
        yield


def _seed_project(root: Path, project_id: str, name: str = "Ancien nom") -> Path:
    pdir = root / project_id
    (pdir / "files").mkdir(parents=True)
    (pdir / "project.json").write_text(
        json.dumps({"id": project_id, "name": name, "created_at": "2025-01-01T00:00:00+00:00"}),
        encoding="utf-8",
    )
    return pdir


def test_rename_project_updates_name_and_keeps_created_at(
    client: TestClient, tmp_path: Path
) -> None:
    pdir = _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/proj-a", json={"name": "Nouveau nom"})

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "id": "proj-a",
        "name": "Nouveau nom",
        "created_at": "2025-01-01T00:00:00+00:00",
    }
    on_disk = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    assert on_disk["name"] == "Nouveau nom"
    assert on_disk["created_at"] == "2025-01-01T00:00:00+00:00"


def test_rename_project_trims_whitespace(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/proj-a", json={"name": "  Nom espacé  "})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Nom espacé"


def test_rename_project_rejects_empty_name(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/proj-a", json={"name": "   "})
    assert resp.status_code == 422


def test_rename_project_accepts_80_char_name(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/proj-a", json={"name": "x" * 80})
    assert resp.status_code == 200
    assert resp.json()["name"] == "x" * 80


def test_rename_project_rejects_overlong_name(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/proj-a", json={"name": "x" * 81})
    assert resp.status_code == 422


def test_rename_unknown_project_returns_404(client: TestClient, tmp_path: Path) -> None:
    with _projects_dir(tmp_path):
        resp = client.patch("/projects/nope", json={"name": "Peu importe"})
    assert resp.status_code == 404
