"""Semantic similarity helpers — exercised against a fake in-memory collection."""

from __future__ import annotations

from typing import Any

import numpy as np

from app.graph.semantic import compute_mean_embedding, find_nearest_papers


class _FakeCollection:
    """Minimal in-memory Chroma collection supporting get + query."""

    def __init__(self) -> None:
        # {stem: list[(meta, embedding)]}
        self._docs: dict[str, list[tuple[dict[str, Any], list[float]]]] = {}

    def add(self, stem: str, embeddings: list[list[float]]) -> None:
        rows = self._docs.setdefault(stem, [])
        for i, emb in enumerate(embeddings):
            rows.append(({"source_stem": stem, "chunk_index": i}, emb))

    # Mirrors the chromadb.Collection API we actually call.
    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        include = include or []
        if where and "source_stem" in where:
            stem = where["source_stem"]
            rows = self._docs.get(stem, [])
            ids = [f"{stem}__chunk_{i:04d}" for i in range(len(rows))]
            out: dict[str, Any] = {"ids": ids}
            if "metadatas" in include:
                out["metadatas"] = [m for m, _e in rows]
            if "embeddings" in include:
                out["embeddings"] = [e for _m, e in rows]
            return out
        return {"ids": [], "metadatas": [], "embeddings": []}

    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        target = query_embeddings[0]
        scored: list[tuple[dict[str, Any], list[float], float]] = []
        for rows in self._docs.values():
            for meta, emb in rows:
                # cosine distance via 1 - cos_sim
                dot = sum(a * b for a, b in zip(target, emb))
                na = sum(a * a for a in target) ** 0.5
                nb = sum(b * b for b in emb) ** 0.5
                if na == 0 or nb == 0:
                    sim = 0.0
                else:
                    sim = dot / (na * nb)
                scored.append((meta, emb, 1.0 - sim))
        scored.sort(key=lambda t: t[2])
        scored = scored[:n_results]
        return {
            "ids": [[f"{m['source_stem']}__chunk_{m['chunk_index']:04d}" for m, _e, _d in scored]],
            "distances": [[d for _m, _e, d in scored]],
            "metadatas": [[m for m, _e, _d in scored]],
        }


class _NumpyCollection(_FakeCollection):
    """`_FakeCollection` whose `get` returns embeddings as a numpy ndarray —
    mirrors chromadb >= 1.5, which switched `get(include=["embeddings"])` to
    ndarray output."""

    def get(
        self,
        where: dict[str, Any] | None = None,
        include: list[str] | None = None,
    ) -> dict[str, Any]:
        out = super().get(where=where, include=include)
        if "embeddings" in out:
            out["embeddings"] = np.asarray(out["embeddings"], dtype=float)
        return out


class TestComputeMeanEmbedding:
    def test_returns_mean_of_chunks(self) -> None:
        col = _FakeCollection()
        col.add("p1", [[1.0, 0.0], [0.0, 1.0]])
        mean = compute_mean_embedding(col, "p1")  # type: ignore[arg-type]
        assert mean == [0.5, 0.5]

    def test_missing_stem_returns_none(self) -> None:
        col = _FakeCollection()
        assert compute_mean_embedding(col, "absent") is None  # type: ignore[arg-type]

    def test_numpy_array_embeddings(self) -> None:
        """chromadb >= 1.5 returns `get(include=["embeddings"])` as a numpy
        ndarray. The old `result.get("embeddings") or []` raised
        "truth value of an array is ambiguous" — silently wiping every
        semantic edge during a graph rebuild. Guard against the regression.
        """
        col = _NumpyCollection()
        col.add("p1", [[1.0, 0.0], [0.0, 1.0]])
        mean = compute_mean_embedding(col, "p1")  # type: ignore[arg-type]
        assert mean == [0.5, 0.5]

    def test_numpy_empty_embeddings_returns_none(self) -> None:
        col = _NumpyCollection()
        assert compute_mean_embedding(col, "absent") is None  # type: ignore[arg-type]


class TestFindNearestPapers:
    def test_returns_top_k_above_threshold(self) -> None:
        col = _FakeCollection()
        col.add("p1", [[1.0, 0.0]])
        col.add("p2", [[0.99, 0.01]])  # ~identical to p1
        col.add("p3", [[0.0, 1.0]])  # orthogonal — sim ≈ 0
        out = find_nearest_papers(col, [1.0, 0.0], exclude_stem="p1", k=5, threshold=0.5)  # type: ignore[arg-type]
        assert [stem for stem, _sim in out] == ["p2"]
        assert out[0][1] > 0.95

    def test_excludes_self_stem(self) -> None:
        col = _FakeCollection()
        col.add("p1", [[1.0, 0.0]])
        col.add("p2", [[1.0, 0.0]])
        out = find_nearest_papers(col, [1.0, 0.0], exclude_stem="p1", k=5, threshold=0.0)  # type: ignore[arg-type]
        assert all(stem != "p1" for stem, _sim in out)

    def test_collapses_chunks_to_paper(self) -> None:
        col = _FakeCollection()
        col.add("p1", [[1.0, 0.0]])
        # Many chunks of p2 — must show up once, not three times.
        col.add("p2", [[1.0, 0.0], [0.95, 0.05], [0.9, 0.1]])
        out = find_nearest_papers(col, [1.0, 0.0], exclude_stem="p1", k=5, threshold=0.5)  # type: ignore[arg-type]
        stems = [stem for stem, _sim in out]
        assert stems.count("p2") == 1

    def test_empty_query_vec(self) -> None:
        col = _FakeCollection()
        col.add("p1", [[1.0]])
        assert find_nearest_papers(col, [], "p1") == []  # type: ignore[arg-type]
