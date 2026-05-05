"""Integration tests for the POST /projects/{id}/papers/reindex endpoint."""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_sse(raw: str) -> list[dict[str, Any]]:
    """Parse a raw SSE response body into a list of JSON event dicts."""
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            events.append(json.loads(payload))
    return events


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj1"
    (d / "files").mkdir(parents=True)
    return d


# ---------------------------------------------------------------------------
# Fake in-memory ChromaDB collection
# ---------------------------------------------------------------------------


class _FakeCollection:
    """Minimal in-memory ChromaDB collection stub."""

    def __init__(self) -> None:
        # {stem: [{metadata dict}, ...]}
        self._docs: dict[str, list[dict[str, Any]]] = {}

    # -- read --

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        if where and "source_stem" in where:
            stem = where["source_stem"]
            metas = self._docs.get(stem, [])
            ids = [f"{stem}__chunk_{i:04d}" for i in range(len(metas))]
            return {"ids": ids, "metadatas": metas, "documents": [""]*len(metas)}
        # Full scan (export)
        all_metas: list[dict[str, Any]] = []
        for metas in self._docs.values():
            all_metas.extend(metas)
        return {"ids": list(range(len(all_metas))), "metadatas": all_metas}

    # -- write --

    def delete(self, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> None:
        if where and "source_stem" in where:
            self._docs.pop(where["source_stem"], None)
        elif ids is not None:
            # ids are like "stem__chunk_0000"
            stems = {i.rsplit("__chunk_", 1)[0] for i in ids}
            for s in stems:
                self._docs.pop(s, None)

    def add(
        self,
        documents: list[str],
        ids: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        if not metadatas:
            return
        stem = str(metadatas[0]["source_stem"])
        self._docs[stem] = list(metadatas)

    def update(
        self,
        ids: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        if not metadatas:
            return
        stem = str(metadatas[0]["source_stem"])
        self._docs[stem] = list(metadatas)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestReindexEndpoint:
    def _make_txt_meta(self, stem: str, notes: str = "") -> dict[str, Any]:
        return {
            "source_stem": stem,
            "source_filename": f"{stem}.txt",
            "chunk_index": 0,
            "chunk_total": 1,
            "word_count": 3,
            "pdf_title": f"Title {stem}",
            "author": "Author A",
            "year": "2024",
            "source_type": "document",
            "authors_json": "",
            "publication": "",
            "doi": "",
            "abstract": "",
            "notes": notes,
        }

    def _run_reindex(
        self,
        client: TestClient,
        project_dir: Path,
        collection: _FakeCollection,
    ) -> list[dict[str, Any]]:
        with (
            patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
            patch("app.ingestion.get_collection", return_value=collection),
            patch("app.ingestion.evict_collection"),
        ):
            resp = client.post(f"/projects/{project_dir.name}/papers/reindex")
        assert resp.status_code == 200
        return _parse_sse(resp.text)

    def test_empty_project_returns_done(
        self, client: TestClient, project_dir: Path
    ) -> None:
        col = _FakeCollection()
        events = self._run_reindex(client, project_dir, col)
        done = next(e for e in events if e["type"] == "done")
        assert done["total"] == 0
        assert done["failed"] == 0

    def test_single_file_indexed_and_done_event(
        self, client: TestClient, project_dir: Path
    ) -> None:
        # Write a real plain-text file so the parser succeeds.
        txt = project_dir / "files" / "paper1.txt"
        txt.write_text("Hello world. This is a test paper.\n\nSecond paragraph here.")

        col = _FakeCollection()
        events = self._run_reindex(client, project_dir, col)

        result_events = [e for e in events if e["type"] == "result"]
        assert len(result_events) == 1
        assert result_events[0]["stem"] == "paper1"

        done = next(e for e in events if e["type"] == "done")
        assert done["total"] == 1
        assert done["failed"] == 0

    def test_saved_metadata_restored_after_reindex(
        self, client: TestClient, project_dir: Path
    ) -> None:
        txt = project_dir / "files" / "paper1.txt"
        txt.write_text("Content for reindex test.\n\nMore content here.")

        col = _FakeCollection()
        # Pre-populate collection with saved notes
        col._docs["paper1"] = [self._make_txt_meta("paper1", notes="My important note")]

        events = self._run_reindex(client, project_dir, col)

        done = next(e for e in events if e["type"] == "done")
        assert done["total"] == 1
        assert done["failed"] == 0

        # After reindex the notes field should be restored
        restored = col.get(where={"source_stem": "paper1"})["metadatas"]
        assert restored, "No metadata found after reindex"
        assert restored[0].get("notes") == "My important note"

    def test_unreadable_file_counts_as_failed(
        self, client: TestClient, project_dir: Path
    ) -> None:
        txt = project_dir / "files" / "bad.txt"
        txt.write_text("dummy")

        col = _FakeCollection()

        with (
            patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
            patch("app.ingestion.get_collection", return_value=col),
            patch("app.ingestion.evict_collection"),
            patch("pathlib.Path.read_bytes", side_effect=OSError("permission denied")),
        ):
            resp = client.post(f"/projects/{project_dir.name}/papers/reindex")

        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        done = next(e for e in events if e["type"] == "done")
        assert done["failed"] == 1
        assert done["total"] == 0

    def test_done_event_includes_failed_field(
        self, client: TestClient, project_dir: Path
    ) -> None:
        """done SSE event always carries a 'failed' key even with zero failures."""
        col = _FakeCollection()
        events = self._run_reindex(client, project_dir, col)
        done = next(e for e in events if e["type"] == "done")
        assert "failed" in done
