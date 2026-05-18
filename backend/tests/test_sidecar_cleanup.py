"""Tests for orphan sidecar cleanup.

A `<stem>.meta.json` sidecar must never outlive its backing document. Orphans
appear when a delete races a concurrent metadata write — e.g. background
auto-enrichment PATCHes a source the user just removed. Two defences:

- `prune_orphan_sidecars` / `GET /papers/` self-heals any orphan on listing.
- `PATCH /papers/{stem}` refuses to write when the document is already gone.
"""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.ingestion import prune_orphan_sidecars
from app.main import app

# ---------------------------------------------------------------------------
# prune_orphan_sidecars unit
# ---------------------------------------------------------------------------


def test_prune_removes_sidecar_without_document(tmp_path: Path) -> None:
    files = tmp_path / "files"
    files.mkdir(parents=True)
    (files / "live.txt").write_text("hi", encoding="utf-8")
    (files / "live.meta.json").write_text("{}", encoding="utf-8")
    (files / "orphan.meta.json").write_text("{}", encoding="utf-8")

    removed = prune_orphan_sidecars(tmp_path, valid_stems={"live"})

    assert removed == ["orphan"]
    assert not (files / "orphan.meta.json").exists()
    # The sidecar of a live document is untouched.
    assert (files / "live.meta.json").exists()


def test_prune_is_a_noop_when_every_sidecar_has_a_document(tmp_path: Path) -> None:
    files = tmp_path / "files"
    files.mkdir(parents=True)
    (files / "a.txt").write_text("hi", encoding="utf-8")
    (files / "a.meta.json").write_text("{}", encoding="utf-8")

    assert prune_orphan_sidecars(tmp_path, valid_stems={"a"}) == []
    assert (files / "a.meta.json").exists()


def test_prune_handles_a_missing_directory(tmp_path: Path) -> None:
    # No files/ or pdfs/ yet — must not raise.
    assert prune_orphan_sidecars(tmp_path, valid_stems=set()) == []


# ---------------------------------------------------------------------------
# Route-level behaviour
# ---------------------------------------------------------------------------


class _EmptyCollection:
    """Chroma stub for a project with no indexed chunks."""

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        return {"ids": [], "metadatas": [], "documents": []}


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj-cleanup"
    (d / "files").mkdir(parents=True)
    return d


def _write_sidecar(project_dir: Path, stem: str, *, with_document: bool) -> Path:
    sidecar = project_dir / "files" / f"{stem}.meta.json"
    sidecar.write_text(
        json.dumps({"stem": stem, "filename": f"{stem}.txt", "pdf_title": "T"}),
        encoding="utf-8",
    )
    if with_document:
        (project_dir / "files" / f"{stem}.txt").write_text("hi", encoding="utf-8")
    return sidecar


def test_list_papers_prunes_orphan_sidecars(client: TestClient, project_dir: Path) -> None:
    live = _write_sidecar(project_dir, "live", with_document=True)
    orphan = _write_sidecar(project_dir, "orphan", with_document=False)

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=_EmptyCollection()),
    ):
        resp = client.get(f"/projects/{project_dir.name}/papers/")

    assert resp.status_code == 200, resp.text
    papers = resp.json()
    # Only the source with a real document is listed.
    assert [p["stem"] for p in papers] == ["live"]
    # The orphan sidecar is gone; the live one stays.
    assert not orphan.exists()
    assert live.exists()


def test_patch_404s_when_document_is_gone(client: TestClient, project_dir: Path) -> None:
    # Sidecar present (a delete already raced ahead and removed the document)
    # but no backing file — PATCH must refuse rather than rewrite the orphan.
    _write_sidecar(project_dir, "ghost", with_document=False)

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=_EmptyCollection()),
    ):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/ghost",
            json={"abstract": "late enrichment result"},
        )

    assert resp.status_code == 404, resp.text
