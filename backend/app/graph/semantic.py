"""Paper-paper semantic similarity via mean embeddings + Chroma.

Each paper's signature is the mean of its chunk embeddings. The Chroma query
returns nearest chunks; we group those by `source_stem` and keep the best
match per stem so the result distinguishes papers rather than chunks.

Chroma defaults to cosine distance (= 1 − cosine_similarity); we convert
once at the boundary so consumers work in similarity space.
"""

from __future__ import annotations

import logging

import chromadb

log = logging.getLogger(__name__)


def compute_mean_embedding(collection: chromadb.Collection, stem: str) -> list[float] | None:
    """Mean of all chunk embeddings for *stem*. Returns None if the source
    isn't in the collection (e.g. ingestion failed) or has zero chunks.
    """
    try:
        result = collection.get(where={"source_stem": stem}, include=["embeddings"])
    except Exception as exc:
        log.warning("compute_mean_embedding: collection.get failed for %s: %s", stem, exc)
        return None
    embeddings = result.get("embeddings") or []
    rows: list[list[float]] = []
    for row in embeddings:
        if row is None:
            continue
        try:
            rows.append([float(v) for v in row])
        except (TypeError, ValueError):
            continue
    if not rows:
        return None

    dim = len(rows[0])
    n = len(rows)
    return [sum(row[i] for row in rows) / n for i in range(dim)]


def find_nearest_papers(
    collection: chromadb.Collection,
    mean_vec: list[float],
    exclude_stem: str,
    k: int = 5,
    threshold: float = 0.6,
) -> list[tuple[str, float]]:
    """Return up to *k* (other_stem, cosine_similarity) pairs above *threshold*.

    Over-fetches chunks (the same stem owns many) then groups by stem so the
    result distinguishes papers rather than chunks.
    """
    if not mean_vec:
        return []
    over_fetch = max(k * 8, 40)
    try:
        result = collection.query(
            query_embeddings=[mean_vec],  # type: ignore[arg-type]
            n_results=over_fetch,
            include=["metadatas", "distances"],
        )
    except Exception as exc:
        log.warning("find_nearest_papers: query failed: %s", exc)
        return []

    distances_2d = result.get("distances") or []
    metas_2d = result.get("metadatas") or []
    if not distances_2d or not metas_2d:
        return []
    distances = distances_2d[0]
    metas = metas_2d[0]

    best_per_stem: dict[str, float] = {}
    for meta, dist in zip(metas, distances):
        if not isinstance(meta, dict):
            continue
        other_stem = meta.get("source_stem")
        if not isinstance(other_stem, str) or not other_stem or other_stem == exclude_stem:
            continue
        try:
            sim = 1.0 - float(dist)
        except (TypeError, ValueError):
            continue
        if sim < threshold:
            continue
        prev = best_per_stem.get(other_stem)
        if prev is None or sim > prev:
            best_per_stem[other_stem] = sim

    return sorted(best_per_stem.items(), key=lambda kv: kv[1], reverse=True)[:k]
