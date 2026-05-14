"""HTTP-level tests for /projects/{id}/graph and /graph/rebuild SSE."""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.graph.schema import Graph, GraphEdge, GraphNode
from app.graph.storage import graph_path, write_graph_atomic
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
    d = tmp_path / "proj"
    (d / "files").mkdir(parents=True)
    return d


@pytest.fixture(autouse=True)
def _patch_projects_dir(project_dir: Path) -> Generator[None, None, None]:
    # Patch every module that reads PROJECTS_DIR for graph endpoints + the
    # storage layer that writes graph.json.
    with (
        patch("app.routes.graph.routes.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.storage.PROJECTS_DIR", project_dir.parent),
        patch("app.graph.builder.PROJECTS_DIR", project_dir.parent),
    ):
        yield


class TestGetGraph:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        resp = client.get("/projects/nope/graph")
        assert resp.status_code == 404

    def test_empty_graph_when_file_missing(self, client: TestClient, project_dir: Path) -> None:
        resp = client.get(f"/projects/{project_dir.name}/graph")
        assert resp.status_code == 200
        body = resp.json()
        assert body["nodes"] == []
        assert body["edges"] == []
        assert body["corrupt"] is False

    def test_returns_stored_graph_with_stats(self, client: TestClient, project_dir: Path) -> None:
        g = Graph(
            version=1,
            embed_model="nomic-embed-text",
            updated_at="2026-01-01T00:00:00+00:00",
            nodes=[
                GraphNode(id="paper:a", type="paper", label="A"),
                GraphNode(id="author:smith_j", type="author", label="Smith, J."),
            ],
            edges=[GraphEdge(source="paper:a", target="author:smith_j", type="authored_by")],
        )
        write_graph_atomic(project_dir.name, g)

        resp = client.get(f"/projects/{project_dir.name}/graph")
        body = resp.json()
        assert resp.status_code == 200
        assert body["embed_model"] == "nomic-embed-text"
        assert {n["id"] for n in body["nodes"]} == {"paper:a", "author:smith_j"}
        assert body["stats"]["nodes"]["paper"] == 1
        assert body["stats"]["nodes"]["author"] == 1
        assert body["stats"]["edges"]["authored_by"] == 1

    def test_future_version_returns_corrupt_flag(
        self, client: TestClient, project_dir: Path
    ) -> None:
        graph_path(project_dir.name).write_text(
            json.dumps({"version": 9999, "nodes": [], "edges": []})
        )
        resp = client.get(f"/projects/{project_dir.name}/graph")
        assert resp.status_code == 200
        assert resp.json()["corrupt"] is True


class TestRebuildEndpoint:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        resp = client.post("/projects/nope/graph/rebuild")
        assert resp.status_code == 404

    def test_empty_project_emits_start_and_done(
        self, client: TestClient, project_dir: Path
    ) -> None:
        # Patch get_collection for graph_add_source (won't be called with 0 stems).
        with patch("app.graph.builder.get_collection"):
            resp = client.post(f"/projects/{project_dir.name}/graph/rebuild")
        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        start = next(e for e in events if e["type"] == "graph_start")
        done = next(e for e in events if e["type"] == "graph_done")
        assert start["total"] == 0
        assert done["total"] == 0
        assert done["failed"] == 0


class TestSyncEndpoint:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        resp = client.post("/projects/nope/graph/sync")
        assert resp.status_code == 404

    def test_empty_project_yields_zero_missing(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.graph.builder.get_collection"):
            resp = client.post(f"/projects/{project_dir.name}/graph/sync")
        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        start = next(e for e in events if e["type"] == "graph_start")
        done = next(e for e in events if e["type"] == "graph_done")
        assert start["total"] == 0
        assert done["total"] == 0


class TestSourceCount:
    def test_source_count_zero_when_files_dir_empty(
        self, client: TestClient, project_dir: Path
    ) -> None:
        resp = client.get(f"/projects/{project_dir.name}/graph")
        assert resp.status_code == 200
        assert resp.json()["source_count"] == 0

    def test_source_count_includes_files_without_sidecar(
        self, client: TestClient, project_dir: Path
    ) -> None:
        # Legacy / drag-dropped files have no sidecar yet — the sync path
        # synthesizes one on first touch, so they count toward source_count.
        (project_dir / "files" / "a.txt").write_text("body")
        (project_dir / "files" / "b.txt").write_text("body")
        (project_dir / "files" / "a.meta.json").write_text(
            json.dumps({"stem": "a", "filename": "a.txt"}), encoding="utf-8"
        )
        resp = client.get(f"/projects/{project_dir.name}/graph")
        assert resp.json()["source_count"] == 2
