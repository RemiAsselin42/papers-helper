"""HTTP-level tests for /projects/{id}/citations/search and /citations/context.

Chunks are seeded into a real per-project Chroma collection with *explicit*
3-dim embeddings — matching the dimension the stubbed Ollama embed function
returns for the query (conftest.py). The query text always embeds to
[0.1, 0.2, 0.3], so a chunk's distance is governed purely by its stored
vector, making the ranking deterministic.
"""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.chroma import evict_collection, get_collection
from app.main import app

# The stub query vector (conftest: ollama.embed → [[0.1, 0.2, 0.3]]).
_QUERY_VEC = [0.1, 0.2, 0.3]


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
    # Chroma caches a client/collection per project id process-wide; the id is
    # always "proj" but the path changes every test → evict around each test
    # so a stale collection from a deleted tmp_path is never reused.
    evict_collection(project_dir.name)
    with (
        patch("app.routes.citations.PROJECTS_DIR", project_dir.parent),
        patch("app.chroma.PROJECTS_DIR", project_dir.parent),
        patch("app.settings.PROJECTS_DIR", project_dir.parent),
    ):
        yield
    evict_collection(project_dir.name)


def _chunk_meta(
    stem: str,
    idx: int,
    total: int,
    *,
    author: str = "",
    categories: str = "",
) -> dict[str, Any]:
    return {
        "source_stem": stem,
        "source_filename": f"{stem}.pdf",
        "chunk_index": idx,
        "chunk_total": total,
        "word_count": 100,
        "pdf_title": stem.replace("-", " ").title(),
        "author": author,
        "year": "2024",
        "categories": categories,
    }


def _seed(project_id: str, rows: list[tuple[str, list[float], dict[str, Any]]]) -> None:
    """rows: (chunk_id, embedding, metadata)."""
    col = get_collection(project_id)
    col.add(
        ids=[r[0] for r in rows],
        documents=[f"text of {r[0]}" for r in rows],
        embeddings=[r[1] for r in rows],
        metadatas=[r[2] for r in rows],
    )


class TestSearch:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        resp = client.post("/projects/nope/citations/search", json={"query": "x"})
        assert resp.status_code == 404

    def test_empty_query_rejected(self, client: TestClient, project_dir: Path) -> None:
        resp = client.post(f"/projects/{project_dir.name}/citations/search", json={"query": "   "})
        assert resp.status_code == 400

    def test_non_indexed_project_returns_empty(self, client: TestClient, project_dir: Path) -> None:
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search", json={"query": "neural"}
        )
        assert resp.status_code == 200
        assert resp.json()["results"] == []

    def test_results_ranked_by_similarity(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 2)),
                ("paper-a::1", [0.4, 0.4, 0.4], _chunk_meta("paper-a", 1, 2)),
                ("paper-b::0", [0.5, 0.5, 0.5], _chunk_meta("paper-b", 0, 1)),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search", json={"query": "neural"}
        )
        assert resp.status_code == 200
        body = resp.json()
        results = body["results"]
        assert [r["chunk_id"] for r in results] == ["paper-a::0", "paper-a::1", "paper-b::0"]
        sims = [r["similarity"] for r in results]
        assert sims == sorted(sims, reverse=True)
        assert results[0]["similarity"] == pytest.approx(1.0)
        assert all(0.0 <= s <= 1.0 for s in sims)
        assert results[0]["title"] == "Paper A"

    def test_limit_caps_result_count(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 3)),
                ("paper-a::1", [0.4, 0.4, 0.4], _chunk_meta("paper-a", 1, 3)),
                ("paper-a::2", [0.5, 0.5, 0.5], _chunk_meta("paper-a", 2, 3)),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "limit": 2},
        )
        assert resp.status_code == 200
        assert len(resp.json()["results"]) == 2

    def test_skips_chunks_too_short_to_cite(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 2)),
                # word_count below the citation floor → dropped
                ("paper-a::1", _QUERY_VEC, {**_chunk_meta("paper-a", 1, 2), "word_count": 3}),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search", json={"query": "neural"}
        )
        assert resp.status_code == 200
        assert {r["chunk_id"] for r in resp.json()["results"]} == {"paper-a::0"}

    def test_skips_weakly_related_hits(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 2)),
                # far embedding → similarity ≈ 0, below the relevance floor
                ("paper-b::0", [0.9, 0.9, 0.9], _chunk_meta("paper-b", 0, 1)),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search", json={"query": "neural"}
        )
        assert resp.status_code == 200
        assert {r["chunk_id"] for r in resp.json()["results"]} == {"paper-a::0"}

    def test_strict_mode_bypasses_quality_floors(
        self, client: TestClient, project_dir: Path
    ) -> None:
        # Both rows would be dropped in normal mode — one for being too short,
        # one for a near-zero similarity. Strict mode must keep them so the
        # client-side exact-phrase filter can decide.
        _seed(
            project_dir.name,
            [
                ("short::0", _QUERY_VEC, {**_chunk_meta("short", 0, 1), "word_count": 3}),
                ("far::0", [0.9, 0.9, 0.9], _chunk_meta("far", 0, 1)),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "strict": True},
        )
        assert resp.status_code == 200
        assert {r["chunk_id"] for r in resp.json()["results"]} == {"short::0", "far::0"}

    def test_filter_by_stem(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 1)),
                ("paper-b::0", [0.4, 0.4, 0.4], _chunk_meta("paper-b", 0, 1)),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "stem": "paper-b"},
        )
        assert resp.status_code == 200
        results = resp.json()["results"]
        assert {r["stem"] for r in results} == {"paper-b"}

    def test_filter_by_author(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 1, author="Smith, J.")),
                ("paper-b::0", [0.4, 0.4, 0.4], _chunk_meta("paper-b", 0, 1, author="Doe, A.")),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "author": "Doe, A."},
        )
        assert resp.status_code == 200
        results = resp.json()["results"]
        assert {r["author"] for r in results} == {"Doe, A."}

    def test_filter_by_category_post_filters_csv(
        self, client: TestClient, project_dir: Path
    ) -> None:
        _seed(
            project_dir.name,
            [
                ("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 1, categories="ml, nlp")),
                ("paper-b::0", [0.4, 0.4, 0.4], _chunk_meta("paper-b", 0, 1, categories="vision")),
            ],
        )
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "category": "nlp"},
        )
        assert resp.status_code == 200
        results = resp.json()["results"]
        assert {r["stem"] for r in results} == {"paper-a"}

    def test_category_filter_does_not_underfill_when_matches_rank_low(
        self, client: TestClient, project_dir: Path
    ) -> None:
        # 10 closer chunks rank above 2 category-matching chunks. With limit=2
        # the fixed over-fetch (limit × 4 = 8 candidates) never reaches the
        # matching rows — only the full-collection fetch for category searches
        # does, so all matching chunks must still surface.
        rows: list[tuple[str, list[float], dict[str, Any]]] = [
            (f"near-{i}::0", [0.1, 0.2, 0.31], _chunk_meta(f"near-{i}", 0, 1)) for i in range(10)
        ]
        rows += [
            (
                f"match-{i}::0",
                [0.15, 0.2, 0.3],
                _chunk_meta(f"match-{i}", 0, 1, categories="nlp"),
            )
            for i in range(2)
        ]
        _seed(project_dir.name, rows)
        resp = client.post(
            f"/projects/{project_dir.name}/citations/search",
            json={"query": "neural", "limit": 2, "category": "nlp"},
        )
        assert resp.status_code == 200
        results = resp.json()["results"]
        assert len(results) == 2
        assert all(r["stem"].startswith("match-") for r in results)


class TestContext:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        resp = client.get("/projects/nope/citations/context?stem=x&chunk_index=0")
        assert resp.status_code == 404

    def test_returns_bounded_window(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [(f"paper-c::{i}", _QUERY_VEC, _chunk_meta("paper-c", i, 7)) for i in range(7)],
        )
        resp = client.get(
            f"/projects/{project_dir.name}/citations/context?stem=paper-c&chunk_index=3&radius=2"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["stem"] == "paper-c"
        assert [c["chunk_index"] for c in body["chunks"]] == [1, 2, 3, 4, 5]

    def test_window_clamps_at_document_start(self, client: TestClient, project_dir: Path) -> None:
        _seed(
            project_dir.name,
            [(f"paper-c::{i}", _QUERY_VEC, _chunk_meta("paper-c", i, 7)) for i in range(7)],
        )
        resp = client.get(
            f"/projects/{project_dir.name}/citations/context?stem=paper-c&chunk_index=0&radius=2"
        )
        assert resp.status_code == 200
        assert [c["chunk_index"] for c in resp.json()["chunks"]] == [0, 1, 2]

    def test_radius_out_of_range_rejected(self, client: TestClient, project_dir: Path) -> None:
        resp = client.get(
            f"/projects/{project_dir.name}/citations/context?stem=paper-c&chunk_index=0&radius=99"
        )
        assert resp.status_code == 422
