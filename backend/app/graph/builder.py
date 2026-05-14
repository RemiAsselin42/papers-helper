"""Async orchestrators that combine sidecar I/O, LLM extraction, Chroma access
and graph storage. These are the only functions the rest of the codebase
calls from outside `app.graph`.

Imports from `app.ingestion` are deliberately late (inside function bodies)
to break the cycle: ingestion calls into these orchestrators after each
successful index step.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Any

import chromadb

from app.chroma import get_collection
from app.config import PROJECTS_DIR
from app.graph.build import (
    derive_paper_contribution,
    graph_stats,
    merge_paper,
    remove_paper,
)
from app.graph.concepts import extract_concepts
from app.graph.schema import Graph, GraphEdge, paper_node_id
from app.graph.semantic import compute_mean_embedding, find_nearest_papers
from app.graph.storage import (
    GRAPH_SCHEMA_VERSION,
    GraphSchemaMismatchError,
    get_lock,
    read_graph,
    write_graph_atomic,
)

log = logging.getLogger(__name__)

K_SEMANTIC = 5
SEMANTIC_THRESHOLD = 0.6


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _files_dir(project_id: str):  # type: ignore[no-untyped-def]
    return PROJECTS_DIR / project_id / "files"


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _synthesize_sidecar(project_id: str, stem: str) -> Any | None:
    """Build a minimal sidecar for legacy projects where a file exists on disk
    (or chunks exist in Chroma) but no `.meta.json` was ever written.

    Resolution order:
    1. Match a file on disk by stem — recover filename + extension.
    2. Fall back to Chroma metadata for that stem — recover title/author/etc.
    3. Return None if neither is found.

    The synthesized sidecar is persisted by the caller so subsequent graph
    operations don't pay the resolution cost again.
    """
    from app.ingestion import SidecarMeta, iter_source_files

    project_dir = PROJECTS_DIR / project_id

    filename = ""
    source_type = "document"
    try:
        for f in iter_source_files(project_dir):
            if f.stem == stem:
                filename = f.name
                source_type = f.suffix.lstrip(".").lower() or "document"
                break
    except Exception:
        pass

    # Pull whatever metadata Chroma already holds for this stem. For legacy
    # projects this is often richer than what disk alone gives us (title,
    # author, abstract); when Chroma is unreachable or has nothing, we keep
    # the minimal disk-derived record.
    chroma_meta: dict[str, Any] = {}
    try:
        collection = get_collection(project_id)
        result = collection.get(where={"source_stem": stem}, include=["metadatas"])
        metas = result.get("metadatas") or []
        if metas:
            chroma_meta = dict(metas[0])
    except Exception:
        pass

    if not filename and not chroma_meta:
        return None

    return SidecarMeta(
        stem=stem,
        filename=filename or str(chroma_meta.get("source_filename", stem)),
        source_type=str(chroma_meta.get("source_type", source_type)),
        pdf_title=str(chroma_meta.get("pdf_title", "")) or stem,
        author=str(chroma_meta.get("author", "")),
        year=str(chroma_meta.get("year", "")),
        authors_json=str(chroma_meta.get("authors_json", "")),
        publication=str(chroma_meta.get("publication", "")),
        doi=str(chroma_meta.get("doi", "")),
        abstract=str(chroma_meta.get("abstract", "")),
        notes=str(chroma_meta.get("notes", "")),
        categories=str(chroma_meta.get("categories", "")),
        # Mark as indexed if Chroma already has chunks for it.
        indexed_at=str(chroma_meta.get("indexed_at", "")) or ("1" if chroma_meta else ""),
    )


async def _ensure_concepts(project_id: str, stem: str) -> tuple[Any | None, list[str]]:
    """Load sidecar + extract/cache concepts if missing. Returns (sidecar, concepts).
    Sidecar is `None` if no sidecar exists *and* nothing on disk or in Chroma
    can be used to synthesize one — caller treats this as a skip.

    TODO(follow-up): bulk uploads pay one sequential LLM round-trip per
    source for concept extraction, so a ZIP of N papers blocks the SSE
    stream for N × (token-latency) seconds. Investigate batching the
    extraction prompts (N papers per Ollama call, structured output) or
    moving extraction off the upload critical path entirely (queue +
    later refresh). Tracked separately from this PR.
    """
    from app.ingestion import read_sidecar, write_sidecar

    files_dir = _files_dir(project_id)
    sidecar = await asyncio.to_thread(read_sidecar, files_dir, stem)
    if sidecar is None:
        # Legacy / drag-dropped sources: no `.meta.json` was ever written.
        # Build a minimal one so the graph can at least represent the paper.
        sidecar = await asyncio.to_thread(_synthesize_sidecar, project_id, stem)
        if sidecar is not None:
            await asyncio.to_thread(write_sidecar, files_dir, sidecar)
    if sidecar is None:
        return None, []

    cached = sidecar.concepts_json or ""
    if cached:
        try:
            raw = json.loads(cached)
            if isinstance(raw, list):
                concepts = [c for c in raw if isinstance(c, str) and c.strip()]
                if concepts:
                    return sidecar, concepts
        except json.JSONDecodeError:
            pass

    concepts = await extract_concepts(sidecar.pdf_title, sidecar.abstract)
    if concepts:
        sidecar.concepts_json = json.dumps(concepts, ensure_ascii=False)
        await asyncio.to_thread(write_sidecar, files_dir, sidecar)
    return sidecar, concepts


def _compute_semantic_edges(
    paper_id: str,
    stem: str,
    collection: chromadb.Collection,
) -> tuple[list[GraphEdge], str]:
    """Sync helper run in a thread. Returns (edges, embed_model_label)."""
    embed_model = ""
    try:
        meta = collection.metadata or {}
        embed_model = str(meta.get("embed_model", "") or "")
    except Exception:
        pass

    mean = compute_mean_embedding(collection, stem)
    if mean is None:
        return [], embed_model

    neighbours = find_nearest_papers(
        collection, mean, stem, k=K_SEMANTIC, threshold=SEMANTIC_THRESHOLD
    )
    edges = [
        GraphEdge(
            source=paper_id,
            target=paper_node_id(other),
            type="semantic",
            weight=sim,
        )
        for other, sim in neighbours
    ]
    return edges, embed_model


async def graph_add_source(project_id: str, stem: str) -> dict[str, Any]:
    """Incrementally add (or replace) a paper in the project graph.

    Idempotent: re-adding the same stem replaces the previous incarnation.
    Robust: failures in concept extraction or semantic embedding are logged
    but never raise — the graph survives partial data.
    """
    sidecar, concepts = await _ensure_concepts(project_id, stem)
    if sidecar is None:
        return {"added": False, "reason": "no_sidecar"}

    paper, aux_nodes, aux_edges = derive_paper_contribution(sidecar, concepts)

    semantic_edges: list[GraphEdge] = []
    embed_model = ""
    try:
        collection = await asyncio.to_thread(get_collection, project_id)
        semantic_edges, embed_model = await asyncio.to_thread(
            _compute_semantic_edges, paper.id, stem, collection
        )
    except Exception as exc:
        log.warning("graph: semantic edges skipped for %s/%s: %s", project_id, stem, exc)

    lock = get_lock(project_id)
    async with lock:
        try:
            graph = await asyncio.to_thread(read_graph, project_id)
        except GraphSchemaMismatchError:
            graph = Graph.empty()
        if embed_model and graph.embed_model and graph.embed_model != embed_model:
            # Embedding space changed — drop existing semantic edges so the
            # new model's geometry replaces the old one paper-by-paper.
            graph.edges = [e for e in graph.edges if e.type != "semantic"]
        if embed_model:
            graph.embed_model = embed_model
        merge_paper(graph, paper, aux_nodes, aux_edges, semantic_edges)
        graph.updated_at = _now_iso()
        graph.version = GRAPH_SCHEMA_VERSION
        await asyncio.to_thread(write_graph_atomic, project_id, graph)

    return {
        "added": True,
        "node_id": paper.id,
        "concepts": len(concepts),
        "semantic_edges": len(semantic_edges),
    }


async def graph_remove_source(project_id: str, stem: str) -> dict[str, Any]:
    paper_id = paper_node_id(stem)
    lock = get_lock(project_id)
    async with lock:
        try:
            graph = await asyncio.to_thread(read_graph, project_id)
        except GraphSchemaMismatchError:
            return {"removed": False, "reason": "schema_mismatch"}
        before = len(graph.nodes)
        remove_paper(graph, paper_id)
        graph.updated_at = _now_iso()
        graph.version = GRAPH_SCHEMA_VERSION
        await asyncio.to_thread(write_graph_atomic, project_id, graph)
        return {"removed": True, "removed_nodes": before - len(graph.nodes)}


async def graph_update_source(project_id: str, stem: str) -> dict[str, Any]:
    """A metadata PATCH (author, categories, abstract, …) re-derives the
    paper's auxiliary nodes. Concepts persist via the sidecar cache; the
    PATCH route in `routes/papers.py` clears `concepts_json` whenever the
    edit touches `pdf_title` or `abstract`, so `_ensure_concepts` will
    re-run extraction here when the source text has actually changed.
    """
    return await graph_add_source(project_id, stem)


async def graph_rebuild(project_id: str) -> AsyncGenerator[str, None]:
    """SSE generator: rebuild the graph in memory, then atomically swap.

    The previous `graph.json` is left untouched until every stem has been
    processed: if the rebuild loop crashes midway, the existing graph
    survives and the user can retry without losing data. The lock is only
    held during the final write so concurrent reads keep seeing the old
    graph throughout the rebuild.

    Emits `graph_*`-prefixed events so a parent stream (e.g. full reindex)
    can multiplex these with its own `start/result/done` without confusion.
    """
    from app.ingestion import iter_source_files, read_sidecar

    project_dir = PROJECTS_DIR / project_id
    files_dir = _files_dir(project_id)

    stems: list[str] = []
    try:
        for f in iter_source_files(project_dir):
            sidecar = read_sidecar(files_dir, f.stem)
            stems.append(sidecar.stem if sidecar is not None else f.stem)
    except Exception as exc:
        yield _sse({"type": "graph_error", "error": str(exc)})
        return

    yield _sse({"type": "graph_start", "total": len(stems)})

    fresh = Graph.empty()
    fresh.version = GRAPH_SCHEMA_VERSION

    # Cache the Chroma collection once: every stem needs it for semantic
    # edges and rebuilding from scratch would reopen the persistent client
    # on each iteration. Failure here is non-fatal — semantic edges are an
    # enrichment and the rebuild proceeds without them.
    collection: chromadb.Collection | None = None
    try:
        collection = await asyncio.to_thread(get_collection, project_id)
    except Exception as exc:
        log.warning("graph_rebuild: collection unavailable for %s: %s", project_id, exc)

    failed = 0
    for index, stem in enumerate(stems):
        try:
            sidecar, concepts = await _ensure_concepts(project_id, stem)
            if sidecar is None:
                yield _sse(
                    {
                        "type": "graph_result",
                        "stem": stem,
                        "index": index + 1,
                        "total": len(stems),
                        "added": False,
                        "reason": "no_sidecar",
                        "concepts": 0,
                        "semantic_edges": 0,
                    }
                )
                continue

            paper, aux_nodes, aux_edges = derive_paper_contribution(sidecar, concepts)

            semantic_edges: list[GraphEdge] = []
            embed_model = ""
            if collection is not None:
                try:
                    semantic_edges, embed_model = await asyncio.to_thread(
                        _compute_semantic_edges, paper.id, stem, collection
                    )
                except Exception as exc:
                    log.warning(
                        "graph_rebuild: semantic edges skipped for %s/%s: %s",
                        project_id,
                        stem,
                        exc,
                    )

            if embed_model:
                fresh.embed_model = embed_model
            merge_paper(fresh, paper, aux_nodes, aux_edges, semantic_edges)

            yield _sse(
                {
                    "type": "graph_result",
                    "stem": stem,
                    "index": index + 1,
                    "total": len(stems),
                    "added": True,
                    "reason": "",
                    "concepts": len(concepts),
                    "semantic_edges": len(semantic_edges),
                }
            )
        except Exception as exc:
            failed += 1
            yield _sse({"type": "graph_error", "stem": stem, "error": str(exc)})

    fresh.updated_at = _now_iso()
    fresh.version = GRAPH_SCHEMA_VERSION

    # Atomic swap — until this write commits, readers still see the old graph.
    lock = get_lock(project_id)
    async with lock:
        try:
            await asyncio.to_thread(write_graph_atomic, project_id, fresh)
        except Exception as exc:
            yield _sse({"type": "graph_error", "error": f"write failed: {exc}"})
            return

    stats = graph_stats(fresh)

    yield _sse(
        {
            "type": "graph_done",
            "total": len(stems),
            "failed": failed,
            "stats": stats,
        }
    )


async def graph_sync(project_id: str) -> AsyncGenerator[str, None]:
    """SSE generator: add the project's already-imported sources to the graph
    *without* wiping. Idempotent — stems whose `paper:<stem>` node is already
    present are skipped (the merge logic is itself idempotent, but skipping
    saves the LLM call for concept extraction).

    Designed to be called fire-and-forget by the frontend whenever the Graph
    view mounts: if everything is already represented, the stream ends almost
    immediately; if pre-existing sources are missing (e.g. imported before the
    Graph feature shipped, or while Ollama generation was unreachable), they
    are added one by one.
    """
    from app.ingestion import iter_source_files, read_sidecar

    project_dir = PROJECTS_DIR / project_id
    files_dir = _files_dir(project_id)

    # Existing paper nodes — anything in this set has already been processed.
    try:
        graph = await asyncio.to_thread(read_graph, project_id)
        existing = {n.id for n in graph.nodes if n.type == "paper"}
    except GraphSchemaMismatchError:
        existing = set()

    missing: list[str] = []
    try:
        for f in iter_source_files(project_dir):
            sidecar = read_sidecar(files_dir, f.stem)
            stem = sidecar.stem if sidecar is not None else f.stem
            if f"paper:{stem}" not in existing:
                missing.append(stem)
    except Exception as exc:
        yield _sse({"type": "graph_error", "error": str(exc)})
        return

    yield _sse({"type": "graph_start", "total": len(missing)})

    failed = 0
    for index, stem in enumerate(missing):
        try:
            result = await graph_add_source(project_id, stem)
            yield _sse(
                {
                    "type": "graph_result",
                    "stem": stem,
                    "index": index + 1,
                    "total": len(missing),
                    "added": bool(result.get("added", False)),
                    "reason": str(result.get("reason", "") or ""),
                    "concepts": int(result.get("concepts", 0)),
                    "semantic_edges": int(result.get("semantic_edges", 0)),
                }
            )
        except Exception as exc:
            failed += 1
            yield _sse({"type": "graph_error", "stem": stem, "error": str(exc)})

    try:
        final_graph = await asyncio.to_thread(read_graph, project_id)
        stats = graph_stats(final_graph)
    except Exception:
        stats = {}

    yield _sse(
        {
            "type": "graph_done",
            "total": len(missing),
            "failed": failed,
            "stats": stats,
        }
    )
