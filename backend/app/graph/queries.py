"""Read-only graph helpers for downstream features.

Consumed by Citations, Similarité, and Aide à la rédaction RAG. These
deliberately do not touch Chroma — they read `graph.json`, which is small,
fast, and stable across embedding-model changes. If a caller wants live
Chroma similarity, they bypass these and use `app.graph.semantic` directly.
"""

from __future__ import annotations

from app.graph.schema import (
    GraphEdge,
    GraphNode,
    author_node_id,
    category_node_id,
    concept_node_id,
    paper_node_id,
)
from app.graph.storage import GraphSchemaMismatchError, read_graph


def _stem_from_paper_id(node_id: str) -> str:
    return node_id[len("paper:") :] if node_id.startswith("paper:") else ""


def nearest_papers(project_id: str, stem: str, k: int = 5) -> list[tuple[str, float]]:
    """Top *k* (stem, similarity) pairs connected by `semantic` edges."""
    try:
        graph = read_graph(project_id)
    except GraphSchemaMismatchError:
        return []
    target = paper_node_id(stem)
    out: list[tuple[str, float]] = []
    for edge in graph.edges:
        if edge.type != "semantic":
            continue
        if edge.source == target:
            other = _stem_from_paper_id(edge.target)
        elif edge.target == target:
            other = _stem_from_paper_id(edge.source)
        else:
            continue
        if other:
            out.append((other, edge.weight))
    return sorted(out, key=lambda kv: kv[1], reverse=True)[:k]


def papers_by_author(project_id: str, family: str, given: str = "") -> list[str]:
    return _papers_linked_to(project_id, author_node_id(family, given), "authored_by")


def papers_by_category(project_id: str, category: str) -> list[str]:
    return _papers_linked_to(project_id, category_node_id(category), "category_of")


def papers_by_concept(project_id: str, concept: str) -> list[str]:
    return _papers_linked_to(project_id, concept_node_id(concept), "concept_of")


def neighborhood(
    project_id: str, node_id: str, depth: int = 1
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Return the sub-graph reachable from *node_id* within *depth* hops.

    Breadth-first over the undirected edge set. The result always contains the
    centre node itself; an empty node list means *node_id* is absent from the
    graph (the caller turns that into a 404). Edges are kept only when both
    endpoints fall inside the visited set.

    This powers `GET /graph/neighbors/{id}` — the entry point for lazily
    exploring a graph too large to ship to the client whole (V1 still loads
    everything; this endpoint is the seam for the >1000-paper case).
    """
    try:
        graph = read_graph(project_id)
    except GraphSchemaMismatchError:
        return [], []

    nodes_by_id = {n.id: n for n in graph.nodes}
    if node_id not in nodes_by_id:
        return [], []

    adjacency: dict[str, list[str]] = {}
    for edge in graph.edges:
        if edge.source == edge.target:
            continue
        adjacency.setdefault(edge.source, []).append(edge.target)
        adjacency.setdefault(edge.target, []).append(edge.source)

    visited: set[str] = {node_id}
    frontier: set[str] = {node_id}
    for _ in range(max(0, depth)):
        nxt: set[str] = set()
        for current in frontier:
            for other in adjacency.get(current, ()):
                if other not in visited:
                    visited.add(other)
                    nxt.add(other)
        if not nxt:
            break
        frontier = nxt

    nodes = [nodes_by_id[i] for i in visited if i in nodes_by_id]
    edges = [e for e in graph.edges if e.source in visited and e.target in visited]
    return nodes, edges


def _papers_linked_to(project_id: str, target_id: str, edge_type: str) -> list[str]:
    if not target_id:
        return []
    try:
        graph = read_graph(project_id)
    except GraphSchemaMismatchError:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for edge in graph.edges:
        if edge.type != edge_type:
            continue
        if edge.target != target_id and edge.source != target_id:
            continue
        paper_side = edge.source if edge.target == target_id else edge.target
        stem = _stem_from_paper_id(paper_side)
        if stem and stem not in seen:
            seen.add(stem)
            out.append(stem)
    return out
