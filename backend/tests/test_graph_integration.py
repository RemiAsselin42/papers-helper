"""Integration tests for the graph hooks attached to ingestion routes.

Validates that:
- A successful upload yields a `graph_updated` SSE event and writes graph.json.
- DELETE /papers/{stem} removes the paper node from the graph.
- PATCH /papers/{stem} re-derives the paper's author/theme/concept nodes.
- POST /papers/reindex multiplexes graph_* events into the stream.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


def _parse_sse(raw: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            out.append(json.loads(line[len("data:") :].strip()))
    return out


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj-graph"
    (d / "files").mkdir(parents=True)
    return d


class _FakeCollection:
    """In-memory Chroma-like collection that records add/get/query."""

    def __init__(self) -> None:
        self._docs: dict[str, list[dict[str, Any]]] = {}
        self._embeddings: dict[str, list[list[float]]] = {}
        self.metadata = {"embed_model": "fake-embed"}

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
        # Embeddings get fabricated deterministically per chunk so semantic
        # tests can predict overlap without driving the real Ollama daemon.
        # `hash()` is salted per-process (PYTHONHASHSEED), so SHA-1 is used
        # instead — stable across processes and CI runs.
        self._embeddings[stem] = [
            [
                int.from_bytes(hashlib.sha1(d.encode("utf-8")).digest()[:2], "big") % 100 / 100.0,
                0.1,
            ]
            for d in documents
        ]

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        include = include or []
        if where and "source_stem" in where:
            stem = where["source_stem"]
            metas = self._docs.get(stem, [])
            embs = self._embeddings.get(stem, [])
            ids = [f"{stem}__chunk_{i:04d}" for i in range(len(metas))]
            out: dict[str, Any] = {"ids": ids}
            if "metadatas" in include:
                out["metadatas"] = metas
            if "embeddings" in include:
                out["embeddings"] = embs
            if "documents" in include:
                out["documents"] = ["" for _ in metas]
            return out
        # Full export
        all_metas: list[dict[str, Any]] = []
        for stem, metas in self._docs.items():
            all_metas.extend(metas)
        return {"ids": list(range(len(all_metas))), "metadatas": all_metas}

    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        # Trivial: return every chunk in arbitrary order with constant distance.
        all_metas: list[dict[str, Any]] = []
        for metas in self._docs.values():
            all_metas.extend(metas)
        return {
            "ids": [[f"x_{i}" for i in range(len(all_metas))][:n_results]],
            "distances": [[0.1] * len(all_metas)][:n_results] or [[0.1] * len(all_metas)],
            "metadatas": [all_metas[:n_results]],
        }

    def delete(self, ids: list[str] | None = None, where: dict[str, Any] | None = None) -> None:
        if where and "source_stem" in where:
            stem = where["source_stem"]
            self._docs.pop(stem, None)
            self._embeddings.pop(stem, None)
        elif ids is not None:
            stems = {i.rsplit("__chunk_", 1)[0] for i in ids}
            for s in stems:
                self._docs.pop(s, None)
                self._embeddings.pop(s, None)

    def update(self, ids: list[str], metadatas: list[dict[str, Any]]) -> None:
        if not metadatas:
            return
        stem = str(metadatas[0]["source_stem"])
        self._docs[stem] = list(metadatas)


@contextmanager
def _patch_all(
    project_dir: Path, collection: _FakeCollection, *, extras: list[Any] | None = None
) -> Generator[None, None, None]:
    """Activate every PROJECTS_DIR + get_collection patch the graph hooks
    need, plus any test-specific `extras`, as one context.

    Tests previously had to spell out `with (patches[0], ..., patches[7]):`
    which broke whenever a new patch was added. ExitStack centralises the
    bundle so future patches are a one-line change here.
    """
    patches = [
        patch("app.routes.papers.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.projects.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.graph.routes.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
        patch("app.ingestion.get_collection", return_value=collection),
        patch("app.graph.builder.get_collection", return_value=collection),
        patch("app.routes.papers.get_collection", return_value=collection),
    ]
    if extras:
        patches.extend(extras)
    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        yield


def test_upload_emits_graph_updated_event(client: TestClient, project_dir: Path) -> None:
    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files={"files": ("paper.txt", b"Hello world.\n\nSecond paragraph.", "text/plain")},
        )
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e["type"] for e in events]
    assert "result" in types
    assert "graph_updated" in types
    update = next(e for e in events if e["type"] == "graph_updated")
    assert update["stem"] == "paper"
    assert update["added"] is True

    # graph.json was written into the isolated tmp project dir.
    graph_path = project_dir / "graph.json"
    assert graph_path.exists()
    data = json.loads(graph_path.read_text(encoding="utf-8"))
    paper_ids = [n["id"] for n in data["nodes"] if n["type"] == "paper"]
    assert "paper:paper" in paper_ids


def test_delete_removes_paper_from_graph(client: TestClient, project_dir: Path) -> None:
    col = _FakeCollection()
    # Seed: upload first so graph.json contains the paper.
    with _patch_all(project_dir, col):
        client.post(
            f"/projects/{project_dir.name}/papers/upload/stream",
            files={"files": ("paper.txt", b"Hello world.\n\nMore content.", "text/plain")},
        )
        assert (project_dir / "graph.json").exists()

        resp = client.delete(f"/projects/{project_dir.name}/papers/paper")
        assert resp.status_code == 204

    data = json.loads((project_dir / "graph.json").read_text(encoding="utf-8"))
    paper_ids = [n["id"] for n in data["nodes"] if n["type"] == "paper"]
    assert "paper:paper" not in paper_ids


def test_sync_synthesizes_sidecar_for_orphan_files(client: TestClient, project_dir: Path) -> None:
    """A PDF dropped into files/ with no sidecar (legacy import or manual
    drag-drop into the data dir) must still end up in the graph after sync —
    the missing sidecar is synthesized on the fly."""
    (project_dir / "files" / "orphan.txt").write_text("Body.\n\nMore.")
    # NO sidecar — this is what triggered the user-visible "empty graph" bug.

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.get(f"/projects/{project_dir.name}/graph")
        assert resp.json()["source_count"] == 1

        sync = client.post(f"/projects/{project_dir.name}/graph/sync")
        assert sync.status_code == 200
        events = _parse_sse(sync.text)
        done = next(e for e in events if e["type"] == "graph_done")
        assert done["total"] == 1
        assert done["failed"] == 0

        resp2 = client.get(f"/projects/{project_dir.name}/graph")
        assert resp2.json()["stats"]["nodes"]["paper"] == 1

    # Sidecar was persisted so subsequent operations don't re-synthesize.
    assert (project_dir / "files" / "orphan.meta.json").exists()


def test_sync_picks_up_legacy_sources(client: TestClient, project_dir: Path) -> None:
    """A project with existing sidecars but no graph.json (legacy import flow)
    should populate after one /graph/sync call."""
    # Seed: txt file + minimal sidecar that mimics a pre-graph-feature import.
    (project_dir / "files" / "legacy.txt").write_text("Body.\n\nMore.")
    (project_dir / "files" / "legacy.meta.json").write_text(
        json.dumps(
            {
                "stem": "legacy",
                "filename": "legacy.txt",
                "source_type": "txt",
                "pdf_title": "Legacy",
                "author": "Anon, A",
                "year": "2024",
                "indexed_at": "1700000000",
            }
        ),
        encoding="utf-8",
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        # Before sync: graph view sees source_count > paper count
        resp = client.get(f"/projects/{project_dir.name}/graph")
        body = resp.json()
        assert body["source_count"] == 1
        assert body["stats"].get("nodes", {}).get("paper", 0) == 0

        # After sync: paper node has been added without any new ingestion call.
        sync = client.post(f"/projects/{project_dir.name}/graph/sync")
        assert sync.status_code == 200
        events = _parse_sse(sync.text)
        done = next(e for e in events if e["type"] == "graph_done")
        assert done["total"] == 1

        resp2 = client.get(f"/projects/{project_dir.name}/graph")
        body2 = resp2.json()
        assert body2["stats"]["nodes"]["paper"] == 1


def test_sync_skips_already_present_papers(client: TestClient, project_dir: Path) -> None:
    """A second sync after the first is a no-op (zero missing stems)."""
    (project_dir / "files" / "legacy.txt").write_text("Body.\n\nMore.")
    (project_dir / "files" / "legacy.meta.json").write_text(
        json.dumps({"stem": "legacy", "filename": "legacy.txt", "indexed_at": "1700000000"}),
        encoding="utf-8",
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        client.post(f"/projects/{project_dir.name}/graph/sync")  # first call
        sync2 = client.post(f"/projects/{project_dir.name}/graph/sync")  # idempotent
        events = _parse_sse(sync2.text)
        done = next(e for e in events if e["type"] == "graph_done")
        assert done["total"] == 0


def test_reindex_emits_graph_events(client: TestClient, project_dir: Path) -> None:
    # Pre-write a file + sidecar so reindex finds something to process.
    (project_dir / "files" / "p1.txt").write_text("Body text.\n\nMore body.")
    col = _FakeCollection()
    with _patch_all(project_dir, col, extras=[patch("app.ingestion.evict_collection")]):
        resp = client.post(f"/projects/{project_dir.name}/papers/reindex")
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e["type"] for e in events]
    assert "graph_start" in types
    assert "graph_done" in types
    done = next(e for e in events if e["type"] == "graph_done")
    assert done["total"] >= 1


def _write_seeded_sidecar(
    project_dir: Path,
    *,
    stem: str,
    pdf_title: str,
    abstract: str,
    concepts_json: str,
) -> None:
    """Place a file + sidecar with pre-populated concepts on disk. Used to
    test the PATCH route's invalidation of stale cached concepts."""
    (project_dir / "files" / f"{stem}.txt").write_text("Body.\n\nMore.")
    (project_dir / "files" / f"{stem}.meta.json").write_text(
        json.dumps(
            {
                "stem": stem,
                "filename": f"{stem}.txt",
                "source_type": "txt",
                "pdf_title": pdf_title,
                "abstract": abstract,
                "concepts_json": concepts_json,
                "indexed_at": "1700000000",
            }
        ),
        encoding="utf-8",
    )


def test_patch_clears_concepts_when_abstract_changes(client: TestClient, project_dir: Path) -> None:
    """The cached concepts_json is derived from (pdf_title, abstract). Editing
    the abstract must invalidate the cache so the next graph build re-extracts
    against the new text — otherwise the graph stays out of sync with the
    paper's actual content."""
    _write_seeded_sidecar(
        project_dir,
        stem="paper1",
        pdf_title="Original Title",
        abstract="original abstract",
        concepts_json='["stale_concept"]',
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper1",
            json={"abstract": "brand new abstract"},
        )
    assert resp.status_code == 200

    sidecar = json.loads((project_dir / "files" / "paper1.meta.json").read_text(encoding="utf-8"))
    assert sidecar["abstract"] == "brand new abstract"
    assert sidecar["concepts_json"] == ""


def test_patch_clears_concepts_when_title_changes(client: TestClient, project_dir: Path) -> None:
    _write_seeded_sidecar(
        project_dir,
        stem="paper2",
        pdf_title="Original Title",
        abstract="some abstract",
        concepts_json='["stale_concept"]',
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper2",
            json={"pdf_title": "New Title"},
        )
    assert resp.status_code == 200

    sidecar = json.loads((project_dir / "files" / "paper2.meta.json").read_text(encoding="utf-8"))
    assert sidecar["pdf_title"] == "New Title"
    assert sidecar["concepts_json"] == ""


def test_patch_preserves_concepts_when_only_unrelated_fields_change(
    client: TestClient, project_dir: Path
) -> None:
    """Editing a field that doesn't feed into concept extraction (author,
    notes, …) must keep the cached concepts so the LLM doesn't get re-paid."""
    _write_seeded_sidecar(
        project_dir,
        stem="paper3",
        pdf_title="Title",
        abstract="abstract",
        concepts_json='["kept_concept"]',
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper3",
            json={"author": "Someone, New"},
        )
    assert resp.status_code == 200

    sidecar = json.loads((project_dir / "files" / "paper3.meta.json").read_text(encoding="utf-8"))
    assert sidecar["author"] == "Someone, New"
    assert sidecar["concepts_json"] == '["kept_concept"]'


def test_patch_preserves_concepts_when_abstract_value_unchanged(
    client: TestClient, project_dir: Path
) -> None:
    """A no-op edit (sending the same abstract back) must not invalidate the
    cache. The diff is by value, not by 'field appeared in payload'."""
    _write_seeded_sidecar(
        project_dir,
        stem="paper4",
        pdf_title="Title",
        abstract="same abstract",
        concepts_json='["kept_concept"]',
    )

    col = _FakeCollection()
    with _patch_all(project_dir, col):
        resp = client.patch(
            f"/projects/{project_dir.name}/papers/paper4",
            json={"abstract": "same abstract"},
        )
    assert resp.status_code == 200

    sidecar = json.loads((project_dir / "files" / "paper4.meta.json").read_text(encoding="utf-8"))
    assert sidecar["concepts_json"] == '["kept_concept"]'
