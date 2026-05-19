"""Tests pour l'export / import d'un projet (archive .zip)."""

from __future__ import annotations

import io
import json
import zipfile
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
    """Redirige PROJECTS_DIR dans les deux modules concernés : `project_io`
    lit/écrit les archives, `projects._read_project` valide l'existence."""
    with (
        patch("app.routes.project_io.PROJECTS_DIR", path),
        patch("app.routes.projects.PROJECTS_DIR", path),
    ):
        yield


def _seed_project(root: Path, project_id: str, name: str = "Mon Projet") -> Path:
    """Crée sur disque un projet minimal mais réaliste."""
    pdir = root / project_id
    (pdir / "files").mkdir(parents=True)
    (pdir / "vectors").mkdir(parents=True)
    (pdir / "conversations").mkdir(parents=True)
    (pdir / "project.json").write_text(
        json.dumps({"id": project_id, "name": name, "created_at": "2025-01-01T00:00:00+00:00"}),
        encoding="utf-8",
    )
    (pdir / "problematique.json").write_text('{"research_problem": "Q"}', encoding="utf-8")
    (pdir / "files" / "paper.txt").write_text("contenu du papier", encoding="utf-8")
    (pdir / "vectors" / "chroma.sqlite3").write_bytes(b"FAKE-SQLITE")
    (pdir / "conversations" / "c1.json").write_text('{"id": "c1"}', encoding="utf-8")
    return pdir


def test_export_includes_vectors_by_default(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.get("/projects/proj-a/export")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = set(zf.namelist())
    assert "_papers_helper_export.json" in names
    assert "project.json" in names
    assert "files/paper.txt" in names
    assert "vectors/chroma.sqlite3" in names


def test_export_excludes_vectors_when_flag_false(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    with _projects_dir(tmp_path):
        resp = client.get("/projects/proj-a/export", params={"include_vectors": "false"})
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = set(zf.namelist())
    assert "project.json" in names
    assert not any(n.startswith("vectors/") for n in names)
    manifest = next(n for n in names if n == "_papers_helper_export.json")
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        meta = json.loads(zf.read(manifest))
    assert meta["include_vectors"] is False


def test_export_missing_project_404(client: TestClient, tmp_path: Path) -> None:
    with _projects_dir(tmp_path):
        resp = client.get("/projects/nope/export")
    assert resp.status_code == 404


def _export(client: TestClient, tmp_path: Path, project_id: str) -> bytes:
    with _projects_dir(tmp_path):
        resp = client.get(f"/projects/{project_id}/export")
    assert resp.status_code == 200
    return resp.content


def _import(client: TestClient, tmp_path: Path, archive: bytes, mode: str = "auto") -> object:
    with _projects_dir(tmp_path):
        return client.post(
            "/projects/import",
            params={"mode": mode},
            files={"file": ("p.papers.zip", archive, "application/zip")},
        )


def test_import_recreates_project_without_conflict(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a", name="Recherche")
    archive = _export(client, tmp_path, "proj-a")
    # Le projet n'existe plus sur la machine cible.
    import shutil

    shutil.rmtree(tmp_path / "proj-a")

    resp = _import(client, tmp_path, archive)
    assert resp.status_code == 201  # type: ignore[attr-defined]
    data = resp.json()  # type: ignore[attr-defined]
    assert data["id"] == "proj-a"
    assert data["name"] == "Recherche"
    assert (tmp_path / "proj-a" / "files" / "paper.txt").read_text(encoding="utf-8") == (
        "contenu du papier"
    )
    assert (tmp_path / "proj-a" / "vectors" / "chroma.sqlite3").exists()
    # Le manifeste ne doit pas être extrait dans le projet.
    assert not (tmp_path / "proj-a" / "_papers_helper_export.json").exists()


def test_import_auto_returns_409_on_conflict(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    archive = _export(client, tmp_path, "proj-a")
    resp = _import(client, tmp_path, archive, mode="auto")
    assert resp.status_code == 409  # type: ignore[attr-defined]
    detail = resp.json()["detail"]  # type: ignore[attr-defined]
    assert detail["conflict"] is True
    assert detail["id"] == "proj-a"


def test_import_replace_overwrites_existing(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a")
    archive = _export(client, tmp_path, "proj-a")
    # Modifie le projet en place pour vérifier qu'il est bien écrasé.
    (tmp_path / "proj-a" / "files" / "paper.txt").write_text("MODIFIÉ", encoding="utf-8")

    resp = _import(client, tmp_path, archive, mode="replace")
    assert resp.status_code == 201  # type: ignore[attr-defined]
    assert resp.json()["id"] == "proj-a"  # type: ignore[attr-defined]
    assert (tmp_path / "proj-a" / "files" / "paper.txt").read_text(encoding="utf-8") == (
        "contenu du papier"
    )


def test_import_duplicate_creates_new_project(client: TestClient, tmp_path: Path) -> None:
    _seed_project(tmp_path, "proj-a", name="Recherche")
    archive = _export(client, tmp_path, "proj-a")

    resp = _import(client, tmp_path, archive, mode="duplicate")
    assert resp.status_code == 201  # type: ignore[attr-defined]
    data = resp.json()  # type: ignore[attr-defined]
    assert data["id"] != "proj-a"
    assert data["name"] == "Recherche (copie)"
    # Le project.json du duplicata porte bien le nouvel id.
    saved = json.loads((tmp_path / data["id"] / "project.json").read_text(encoding="utf-8"))
    assert saved["id"] == data["id"]
    # L'original est intact.
    assert (tmp_path / "proj-a").exists()


def test_import_rejects_invalid_zip(client: TestClient, tmp_path: Path) -> None:
    resp = _import(client, tmp_path, b"not a zip at all")
    assert resp.status_code == 422  # type: ignore[attr-defined]


def test_import_rejects_archive_without_project_json(client: TestClient, tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("random.txt", "hello")
    resp = _import(client, tmp_path, buf.getvalue())
    assert resp.status_code == 422  # type: ignore[attr-defined]


def test_import_rejects_path_traversal(client: TestClient, tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("project.json", '{"id": "x", "name": "x", "created_at": "t"}')
        zf.writestr("../evil.txt", "pwned")
    resp = _import(client, tmp_path, buf.getvalue())
    assert resp.status_code == 422  # type: ignore[attr-defined]


def test_import_rejects_oversized_upload(client: TestClient, tmp_path: Path) -> None:
    """Une archive plus lourde que MAX_UPLOAD_BYTES est refusée (413) avant
    même d'être désérialisée."""
    with patch("app.routes.project_io.MAX_UPLOAD_BYTES", 8):
        resp = _import(client, tmp_path, b"largueur depassee")
    assert resp.status_code == 413  # type: ignore[attr-defined]


def test_import_rejects_oversized_uncompressed(client: TestClient, tmp_path: Path) -> None:
    """Un zip-bomb (total décompressé > MAX_UNCOMPRESSED_BYTES) est refusé (413)."""
    _seed_project(tmp_path, "proj-a")
    archive = _export(client, tmp_path, "proj-a")
    with patch("app.routes.project_io.MAX_UNCOMPRESSED_BYTES", 1):
        resp = _import(client, tmp_path, archive)
    assert resp.status_code == 413  # type: ignore[attr-defined]


def test_replace_failure_keeps_original_intact(tmp_path: Path) -> None:
    """Si l'extraction échoue en mode `replace`, le projet cible existant ne
    doit pas être détruit (extraction en dossier de transit puis bascule)."""
    with TestClient(app, raise_server_exceptions=False) as c:
        _seed_project(tmp_path, "proj-a")
        archive = _export(c, tmp_path, "proj-a")
        # Sentinelle pour vérifier que le projet original survit.
        (tmp_path / "proj-a" / "files" / "paper.txt").write_text(
            "ORIGINAL-INTACT", encoding="utf-8"
        )

        def _boom(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("disque plein simulé")

        with (
            _projects_dir(tmp_path),
            patch("app.routes.project_io.shutil.copyfileobj", _boom),
        ):
            resp = c.post(
                "/projects/import",
                params={"mode": "replace"},
                files={"file": ("p.papers.zip", archive, "application/zip")},
            )

    assert resp.status_code == 500
    # Le projet original est intact, et aucun dossier de transit ne traîne.
    assert (tmp_path / "proj-a" / "files" / "paper.txt").read_text(
        encoding="utf-8"
    ) == "ORIGINAL-INTACT"
    assert not any(p.name.startswith(".import-") for p in tmp_path.iterdir())
