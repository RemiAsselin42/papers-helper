"""Tests for the decoupled import / indexing pipeline.

Stage 1 (upload) only saves + parses files — it never touches Chroma, so it
always succeeds and reports `indexed: false`. Stage 2 (the indexing pass,
POST /papers/index/stream) embeds every not-yet-indexed file; it skips the
ones already in Chroma and surfaces per-file embedding failures. A per-source
reindex still recovers an individual unindexed source.
"""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.ingestion import _add_chunks_resilient, _is_skippable_embed_error
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


def test_upload_saves_and_parses_without_indexing(client: TestClient, project_dir: Path) -> None:
    """Stage 1: the upload only saves + parses the file. It writes no Chroma
    chunks and reports indexed=false — embedding is the index pass's job."""
    recording = _RecordingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=recording),
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
    assert result["index_error"] == ""

    # File and sidecar must both be on disk; Chroma stays empty.
    assert (project_dir / "files" / "paper.txt").exists()
    sidecar = project_dir / "files" / "paper.meta.json"
    assert sidecar.exists()
    meta = json.loads(sidecar.read_text(encoding="utf-8"))
    assert meta["filename"] == "paper.txt"
    assert meta["index_error"] == ""
    assert recording.docs == {}


def _write_unindexed(project_dir: Path, stem: str) -> None:
    (project_dir / "files" / f"{stem}.txt").write_text("Body text.\n\nMore content.")
    (project_dir / "files" / f"{stem}.meta.json").write_text(
        json.dumps({"stem": stem, "filename": f"{stem}.txt", "source_type": "txt"}),
        encoding="utf-8",
    )


def test_index_pass_indexes_pending_files(client: TestClient, project_dir: Path) -> None:
    """Stage 2: the index pass embeds every not-yet-indexed source."""
    _write_unindexed(project_dir, "a")
    _write_unindexed(project_dir, "b")
    recording = _RecordingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=recording),
        patch("app.graph.builder.get_collection", return_value=recording),
    ):
        resp = client.post(f"/projects/{project_dir.name}/papers/index/stream")

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    results = [e for e in events if e["type"] == "result"]
    assert len(results) == 2
    assert all(r["indexed"] is True for r in results)
    assert set(recording.docs.keys()) == {"a", "b"}
    done = next(e for e in events if e["type"] == "done")
    assert done["total"] == 2


def test_index_pass_skips_already_indexed_files(client: TestClient, project_dir: Path) -> None:
    """A source already present in Chroma is not re-embedded."""
    _write_unindexed(project_dir, "a")
    _write_unindexed(project_dir, "b")
    recording = _RecordingCollection()
    # Pretend "a" is already indexed.
    recording.docs["a"] = [
        {"source_stem": "a", "chunk_index": 0, "chunk_total": 1, "source_filename": "a.txt"}
    ]

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=recording),
        patch("app.graph.builder.get_collection", return_value=recording),
    ):
        resp = client.post(f"/projects/{project_dir.name}/papers/index/stream")

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    queued = next(e for e in events if e["type"] == "queued")
    assert queued["filenames"] == ["b.txt"]
    results = [e for e in events if e["type"] == "result"]
    assert len(results) == 1
    assert results[0]["stem"] == "b"


class _NaNRejectingCollection:
    """`add` rejects any batch containing a flagged chunk with a NaN-encode
    error — like Ollama on a degenerate chunk that yields a NaN vector."""

    def __init__(self, bad: str) -> None:
        self.bad = bad
        self.added: list[str] = []

    def add(self, ids: list[str], documents: list[str], metadatas: list[dict[str, Any]]) -> None:
        if self.bad in documents:
            raise RuntimeError("failed to encode response: json: unsupported value: NaN")
        self.added.extend(ids)


def test_add_chunks_resilient_skips_only_the_nan_chunk() -> None:
    coll = _NaNRejectingCollection("BAD")
    ids = [f"c{i}" for i in range(6)]
    docs = ["ok", "ok", "BAD", "ok", "ok", "ok"]
    added = _add_chunks_resilient(coll, ids, docs, [{} for _ in ids])  # type: ignore[arg-type]
    assert added == 5
    assert set(coll.added) == {"c0", "c1", "c3", "c4", "c5"}


def test_add_chunks_resilient_reraises_transient_errors() -> None:
    class _Transient:
        def add(self, **_: object) -> None:
            raise ConnectionError("Ollama unreachable")

    # A transient failure is not chunk-specific — it must propagate so the
    # whole document is failed and retried, not silently drop every chunk.
    with pytest.raises(ConnectionError):
        _add_chunks_resilient(_Transient(), ["c0"], ["x"], [{}])  # type: ignore[arg-type]


def test_is_skippable_embed_error_flags_deterministic_failures() -> None:
    # A degenerate (NaN) chunk and a context-overflow chunk both fail
    # reproducibly for that exact chunk — skippable.
    assert _is_skippable_embed_error(RuntimeError("json: unsupported value: NaN"))
    assert _is_skippable_embed_error(RuntimeError("input length exceeds context length"))
    # A transient failure is not chunk-specific — it must propagate.
    assert not _is_skippable_embed_error(ConnectionError("read timed out"))


class _ContextOverflowCollection:
    """`add` rejects any batch holding a chunk longer than `limit` chars with
    an Ollama-style context-overflow 400 — like a too-coarse granularity
    paired with a small-context embed model."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.added: dict[str, str] = {}

    def add(self, ids: list[str], documents: list[str], metadatas: list[dict[str, Any]]) -> None:
        if any(len(d) > self.limit for d in documents):
            raise RuntimeError("input length exceeds context length")
        for chunk_id, doc in zip(ids, documents):
            self.added[chunk_id] = doc


def test_add_chunks_resilient_resplits_oversized_chunk() -> None:
    """An oversized chunk is re-split smaller and retried — its text is kept,
    not dropped — so a coarse granularity setting degrades gracefully."""
    coll = _ContextOverflowCollection(limit=100)
    doc = "".join(chr(65 + i % 26) for i in range(400))  # 4× the model's window
    added = _add_chunks_resilient(coll, ["c0"], [doc], [{}])  # type: ignore[arg-type]
    assert added == len(coll.added) > 1
    # Every stored sub-chunk now fits the model's window...
    assert all(len(d) <= 100 for d in coll.added.values())
    # ...and no text was lost: the sub-chunks reassemble the original.
    assert "".join(coll.added[k] for k in sorted(coll.added)) == doc


def test_add_chunks_resilient_drops_unsplittable_oversized_chunk() -> None:
    """A chunk that still overflows but is too short to halve is dropped as a
    last resort rather than recursing forever."""
    coll = _ContextOverflowCollection(limit=0)  # rejects every non-empty chunk
    added = _add_chunks_resilient(coll, ["c0"], ["x"], [{}])  # type: ignore[arg-type]
    assert added == 0
    assert coll.added == {}


def test_index_pass_reports_embedding_failure(client: TestClient, project_dir: Path) -> None:
    """When embedding fails, the index pass keeps the file and surfaces the
    error per source instead of aborting the whole pass."""
    _write_unindexed(project_dir, "a")
    raising = _RaisingCollection()

    with (
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=raising),
        patch("app.graph.builder.get_collection", return_value=raising),
    ):
        resp = client.post(f"/projects/{project_dir.name}/papers/index/stream")

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    result = next(e for e in events if e["type"] == "result")
    assert result["indexed"] is False
    assert "Ollama unreachable" in result["index_error"]


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
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=recording),
        patch("app.graph.builder.get_collection", return_value=recording),
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
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.papers.get_collection", return_value=raising),
        patch("app.graph.builder.get_collection", return_value=raising),
    ):
        resp = client.delete(f"/projects/{project_dir.name}/papers/paper")

    assert resp.status_code == 204
    assert not (project_dir / "files" / "paper.txt").exists()
    assert not (project_dir / "files" / "paper.meta.json").exists()
