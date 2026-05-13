"""Tests for importing sources without a working embedding backend.

When Ollama (or the chosen embedding provider) is unreachable, importing a
source must still succeed: the file is kept on disk, a sidecar JSON captures
its metadata, and the SSE stream signals `indexed: false`. A subsequent
per-source reindex must then succeed once the backend is reachable again.
"""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


def _parse_sse(raw: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:") :].strip()))
    return events


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj-import"
    (d / "files").mkdir(parents=True)
    return d


class _RaisingCollection:
    """Collection stub whose `add` always raises — simulates Ollama down."""

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        return {"ids": [], "metadatas": [], "documents": []}

    def delete(self, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> None:
        return None

    def add(self, **_: Any) -> None:
        raise ConnectionError("Ollama unreachable")


class _RecordingCollection:
    """Collection stub that records `add` calls — simulates a healthy backend."""

    def __init__(self) -> None:
        self.docs: dict[str, list[dict[str, Any]]] = {}

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        if where and "source_stem" in where:
            stem = where["source_stem"]
            metas = self.docs.get(stem, [])
            ids = [f"{stem}__chunk_{i:04d}" for i in range(len(metas))]
            return {"ids": ids, "metadatas": metas, "documents": [""] * len(metas)}
        all_metas: list[dict[str, Any]] = []
        for metas in self.docs.values():
            all_metas.extend(metas)
        return {"ids": list(range(len(all_metas))), "metadatas": all_metas}

    def delete(self, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> None:
        if where and "source_stem" in where:
            self.docs.pop(where["source_stem"], None)

    def add(
        self,
        documents: list[str],
        ids: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        if metadatas:
            self.docs[str(metadatas[0]["source_stem"])] = list(metadatas)

    def update(self, **_: Any) -> None:
        return None


def test_upload_succeeds_when_embedding_fails(client: TestClient, project_dir: Path) -> None:
    raising = _RaisingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=raising),
    ):
        resp = client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files={"files": ("paper.txt", b"Hello world.\n\nSecond paragraph.", "text/plain")},
        )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    result = next(e for e in events if e["type"] == "result")
    assert result["indexed"] is False
    assert result["chunks_indexed"] == 0
    assert "Ollama unreachable" in result["index_error"]

    # File and sidecar must both be on disk.
    assert (project_dir / "files" / "paper.txt").exists()
    sidecar = project_dir / "files" / "paper.meta.json"
    assert sidecar.exists()
    meta = json.loads(sidecar.read_text(encoding="utf-8"))
    assert meta["filename"] == "paper.txt"
    assert "Ollama unreachable" in meta["index_error"]


def test_list_papers_includes_unindexed_source(client: TestClient, project_dir: Path) -> None:
    # File present without any Chroma row.
    (project_dir / "files" / "paper.txt").write_text("hi")
    sidecar = project_dir / "files" / "paper.meta.json"
    sidecar.write_text(
        json.dumps(
            {
                "stem": "paper",
                "filename": "paper.txt",
                "source_type": "txt",
                "pdf_title": "Hi",
                "author": "Anon",
                "year": "2024",
                "index_error": "ConnectionError: down",
            }
        ),
        encoding="utf-8",
    )

    raising = _RaisingCollection()
    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=raising),
    ):
        resp = client.get(f"/projects/{project_dir.name}/papers/")

    assert resp.status_code == 200
    papers = resp.json()
    assert len(papers) == 1
    p = papers[0]
    assert p["stem"] == "paper"
    assert p["indexed"] is False
    assert p["chunk_total"] == 0
    assert p["pdf_title"] == "Hi"
    assert "down" in p["index_error"]


def test_single_reindex_recovers_unindexed_source(client: TestClient, project_dir: Path) -> None:
    # Pre-existing non-indexed source.
    (project_dir / "files" / "paper.txt").write_text("Hello world.\n\nMore content.")
    (project_dir / "files" / "paper.meta.json").write_text(
        json.dumps(
            {
                "stem": "paper",
                "filename": "paper.txt",
                "source_type": "txt",
                "pdf_title": "P",
                "author": "",
                "year": "",
                "index_error": "ConnectionError: down",
            }
        ),
        encoding="utf-8",
    )

    recording = _RecordingCollection()
    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=recording),
    ):
        resp = client.post(f"/projects/{project_dir.name}/papers/paper/reindex")

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    result = next(e for e in events if e["type"] == "result")
    assert result["indexed"] is True
    assert result["chunks_indexed"] >= 1
    assert result["index_error"] == ""

    # Chroma now holds the source.
    assert "paper" in recording.docs
    # Sidecar cleared the prior error.
    sidecar = json.loads((project_dir / "files" / "paper.meta.json").read_text(encoding="utf-8"))
    assert sidecar["index_error"] == ""


def test_delete_unindexed_source_removes_file_and_sidecar(
    client: TestClient, project_dir: Path
) -> None:
    (project_dir / "files" / "paper.txt").write_text("x")
    (project_dir / "files" / "paper.meta.json").write_text(
        json.dumps({"stem": "paper", "filename": "paper.txt"}),
        encoding="utf-8",
    )

    raising = _RaisingCollection()
    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=raising),
    ):
        resp = client.delete(f"/projects/{project_dir.name}/papers/paper")

    assert resp.status_code == 204
    assert not (project_dir / "files" / "paper.txt").exists()
    assert not (project_dir / "files" / "paper.meta.json").exists()
