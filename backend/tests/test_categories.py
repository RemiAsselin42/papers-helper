"""Tests for the categories metadata field and the legacy brace-stripping migration.

Categories are user-editable, persisted in the sidecar and Chroma metadata, and
surfaced on `PaperInfo`. The brace-stripping helper removes stray `{` / `}`
characters from `pdf_title` while keeping the inner words intact — runs at
ingest, at save, and lazily on the first `GET /papers/` after an upgrade.
"""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.ingestion import SidecarMeta, strip_title_braces
from app.main import app


def test_strip_title_braces_keeps_inner_words() -> None:
    meta = SidecarMeta(stem="s", filename="s.pdf", pdf_title="X {Sub-info} Y")
    changed = strip_title_braces(meta)
    assert changed is True
    assert meta.pdf_title == "X Sub-info Y"


def test_strip_title_braces_does_not_touch_categories() -> None:
    meta = SidecarMeta(stem="s", filename="s.pdf", pdf_title="Foo {Bar}", categories="Existing")
    strip_title_braces(meta)
    # Categories are an independent field now; brace-stripping must not write to them.
    assert meta.categories == "Existing"


def test_strip_title_braces_collapses_extra_whitespace() -> None:
    meta = SidecarMeta(stem="s", filename="s.pdf", pdf_title="A  {  B  }  C")
    strip_title_braces(meta)
    assert meta.pdf_title == "A B C"


def test_strip_title_braces_idempotent_after_one_pass() -> None:
    meta = SidecarMeta(stem="s", filename="s.pdf", pdf_title="X {Y}")
    strip_title_braces(meta)
    assert strip_title_braces(meta) is False
    assert meta.pdf_title == "X Y"


def test_strip_title_braces_noop_on_clean_titles() -> None:
    meta = SidecarMeta(stem="s", filename="s.pdf", pdf_title="Already Clean")
    assert strip_title_braces(meta) is False
    assert meta.pdf_title == "Already Clean"


# ---------------------------------------------------------------------------
# PATCH /papers/{stem} round-trip
# ---------------------------------------------------------------------------


class _CapturingCollection:
    """Minimal Chroma stub that records updates so the test can assert that
    `categories` is mirrored from the sidecar into the per-chunk metadata."""

    def __init__(self) -> None:
        self.metas: list[dict[str, Any]] = []

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        if where and "source_stem" in where:
            stem = where["source_stem"]
            filtered = [m for m in self.metas if m.get("source_stem") == stem]
            return {
                "ids": [f"{stem}__chunk_{i:04d}" for i in range(len(filtered))],
                "metadatas": filtered,
                "documents": [""] * len(filtered),
            }
        return {
            "ids": [f"chunk_{i}" for i in range(len(self.metas))],
            "metadatas": list(self.metas),
        }

    def update(self, ids: list[str], metadatas: list[dict[str, Any]]) -> None:
        # Replace the matching metas in place so subsequent gets see the patch.
        for i, m in enumerate(metadatas):
            stem = m.get("source_stem")
            idx = next(
                (j for j, existing in enumerate(self.metas) if existing.get("source_stem") == stem),
                None,
            )
            if idx is not None:
                self.metas[idx] = m
            else:
                self.metas.append(m)
        _ = ids  # unused — meta keyed by source_stem in this stub


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj-categories"
    (d / "files").mkdir(parents=True)
    return d


def _write_sidecar(project_dir: Path, stem: str, **fields: str) -> None:
    base: dict[str, Any] = {
        "stem": stem,
        "filename": f"{stem}.txt",
        "source_type": "txt",
        "pdf_title": "Some Paper",
        "author": "",
        "year": "",
        "categories": "",
    }
    base.update(fields)
    (project_dir / "files" / f"{stem}.meta.json").write_text(json.dumps(base), encoding="utf-8")
    (project_dir / "files" / f"{stem}.txt").write_text("hi", encoding="utf-8")


def test_patch_round_trips_categories(client: TestClient, project_dir: Path) -> None:
    _write_sidecar(project_dir, "paper", pdf_title="A Paper")
    coll = _CapturingCollection()
    coll.metas.append(
        {
            "source_stem": "paper",
            "source_filename": "paper.txt",
            "chunk_total": 1,
            "chunk_index": 0,
            "categories": "",
        }
    )

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=coll),
        patch("app.graph.builder.get_collection", return_value=coll),
    ):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper",
            json={"categories": "Sociologie, Méthodes"},
        )

    assert resp.status_code == 200, resp.text
    paper = resp.json()
    assert paper["categories"] == "Sociologie, Méthodes"
    # Sidecar persisted.
    sidecar = json.loads((project_dir / "files" / "paper.meta.json").read_text(encoding="utf-8"))
    assert sidecar["categories"] == "Sociologie, Méthodes"
    # Chroma metadata mirrored.
    assert coll.metas[0]["categories"] == "Sociologie, Méthodes"


def test_list_papers_strips_braces_lazily(client: TestClient, project_dir: Path) -> None:
    # Pre-existing source still carrying `{` `}` brace characters.
    _write_sidecar(
        project_dir,
        "paper",
        pdf_title="A Paper {with sub-info} and {more}",
        categories="ExistingCat",
    )
    coll = _CapturingCollection()
    coll.metas.append(
        {
            "source_stem": "paper",
            "source_filename": "paper.txt",
            "chunk_total": 1,
            "chunk_index": 0,
            "pdf_title": "A Paper {with sub-info} and {more}",
            "categories": "ExistingCat",
        }
    )

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=coll),
    ):
        resp = client.get(f"/projects/{project_dir.name}/papers/")

    assert resp.status_code == 200, resp.text
    papers = resp.json()
    assert len(papers) == 1
    # Braces gone, inner words kept.
    assert papers[0]["pdf_title"] == "A Paper with sub-info and more"
    # Categories untouched by the brace strip.
    assert papers[0]["categories"] == "ExistingCat"
    # Sidecar persisted.
    sidecar = json.loads((project_dir / "files" / "paper.meta.json").read_text(encoding="utf-8"))
    assert sidecar["pdf_title"] == "A Paper with sub-info and more"
    assert sidecar["categories"] == "ExistingCat"
    # Chroma row mirrored.
    assert coll.metas[0]["pdf_title"] == "A Paper with sub-info and more"
    assert coll.metas[0]["categories"] == "ExistingCat"


def test_list_papers_migration_is_a_noop_on_clean_titles(
    client: TestClient, project_dir: Path
) -> None:
    # No braces — list_papers must not rewrite the sidecar.
    _write_sidecar(project_dir, "paper", pdf_title="Already Clean")
    sidecar_path = project_dir / "files" / "paper.meta.json"
    mtime_before = sidecar_path.stat().st_mtime_ns

    coll = _CapturingCollection()
    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=coll),
    ):
        resp = client.get(f"/projects/{project_dir.name}/papers/")

    assert resp.status_code == 200
    assert sidecar_path.stat().st_mtime_ns == mtime_before


def test_patch_strips_braces_from_title(client: TestClient, project_dir: Path) -> None:
    # Sidecar still carries `{` `}` characters in the title; save-time
    # cleanup should strip the braces while preserving the inner words.
    _write_sidecar(project_dir, "paper", pdf_title="A Paper {with stuff}", categories="")
    coll = _CapturingCollection()
    coll.metas.append(
        {
            "source_stem": "paper",
            "source_filename": "paper.txt",
            "chunk_total": 1,
            "chunk_index": 0,
            "categories": "",
            "pdf_title": "A Paper {with stuff}",
        }
    )

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=coll),
        patch("app.graph.builder.get_collection", return_value=coll),
    ):
        # PATCH a no-op other field — the cleanup runs regardless.
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper",
            json={"notes": "edited"},
        )

    assert resp.status_code == 200, resp.text
    paper = resp.json()
    assert paper["pdf_title"] == "A Paper with stuff"
    # Categories must not be touched by brace stripping.
    assert paper["categories"] == ""
    sidecar = json.loads((project_dir / "files" / "paper.meta.json").read_text(encoding="utf-8"))
    assert sidecar["pdf_title"] == "A Paper with stuff"
    # Cleanup must propagate to Chroma.
    assert coll.metas[0]["pdf_title"] == "A Paper with stuff"
