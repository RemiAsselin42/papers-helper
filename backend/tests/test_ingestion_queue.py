"""Tests for the SSE `queued` announcement and per-result enrichment flags
emitted by the ingestion pipeline. The frontend toast relies on `queued` to
show every file (including ZIP-extracted ones) upfront, and the auto-enrich
queue uses `has_abstract`/`has_categories` to skip dimensions that already
have content.
"""

from __future__ import annotations

import io
import json
import zipfile
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
    d = tmp_path / "proj-queued"
    (d / "files").mkdir(parents=True)
    return d


class _RecordingCollection:
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


def test_upload_emits_queued_with_all_filenames(client: TestClient, project_dir: Path) -> None:
    """A direct multi-file upload announces the full list upfront."""
    collection = _RecordingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=collection),
        patch("app.graph.builder.get_collection", return_value=collection),
    ):
        resp = client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files=[
                ("files", ("a.txt", b"Alpha text.\n\nSecond paragraph.", "text/plain")),
                ("files", ("b.txt", b"Beta text.\n\nAnother paragraph.", "text/plain")),
            ],
        )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)

    queued = [e for e in events if e["type"] == "queued"]
    assert len(queued) == 1
    assert sorted(queued[0]["filenames"]) == ["a.txt", "b.txt"]

    # The queued event must arrive BEFORE any per-file start.
    queued_idx = next(i for i, e in enumerate(events) if e["type"] == "queued")
    first_start_idx = next(i for i, e in enumerate(events) if e["type"] == "start")
    assert queued_idx < first_start_idx


def test_upload_queued_expands_zip_contents(client: TestClient, project_dir: Path) -> None:
    """When a ZIP is uploaded, the queued event lists the ZIP AND the
    extracted files, so the frontend can render every queued doc upfront."""
    collection = _RecordingCollection()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("inner1.txt", "First inner.\n\nSecond paragraph.")
        zf.writestr("inner2.txt", "Second inner.\n\nMore text.")
    zip_bytes = buf.getvalue()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=collection),
        patch("app.graph.builder.get_collection", return_value=collection),
    ):
        resp = client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files={"files": ("bundle.zip", zip_bytes, "application/zip")},
        )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)

    queued = next(e for e in events if e["type"] == "queued")
    # All three: the zip itself + the two extracted files.
    assert sorted(queued["filenames"]) == ["bundle.zip", "inner1.txt", "inner2.txt"]


def test_result_event_carries_has_abstract_and_has_categories(
    client: TestClient, project_dir: Path
) -> None:
    """A freshly-imported plain text doc has no abstract / categories — the
    flags must reflect that so the frontend enqueues both generations."""
    collection = _RecordingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=collection),
        patch("app.graph.builder.get_collection", return_value=collection),
    ):
        resp = client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files={"files": ("plain.txt", b"Just text.\n\nNo metadata.", "text/plain")},
        )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    result = next(e for e in events if e["type"] == "result" and "stem" in e)
    assert result["has_abstract"] is False
    assert result["has_categories"] is False
    assert result["stem"] == "plain"
