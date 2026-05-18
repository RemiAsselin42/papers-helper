"""Louvain community detection over the knowledge graph.

Communities are a *view* concern: they cluster papers with the concepts,
categories and authors they share into automatically-discovered groups. The
result is small and cheap to compute (the graph stays well under ~1000
papers in V1), so `assign_communities` runs on read — the GET /graph route
calls it after loading `graph.json` and stamps `data["community"]` on every
node so the frontend can colour by cluster.

Deliberately *not* persisted: keeping it out of `graph.json` means the result
is always consistent with the current node/edge set and avoids a schema bump.
"""

from __future__ import annotations

import logging

import networkx as nx
from networkx.algorithms.community import louvain_communities

from app.graph.schema import Graph

log = logging.getLogger(__name__)


def assign_communities(graph: Graph) -> int:
    """Run weighted Louvain over *graph* and stamp `data["community"]` (an int
    index) on every node in place. Returns the number of communities found.

    Communities are ordered by size, descending, so community 0 is always the
    largest — this gives the frontend a stable colour ordering across reads.

    Best-effort: an algorithm error falls back to a single community 0 so
    callers never have to handle a partial result.
    """
    if not graph.nodes:
        return 0

    nx_graph = nx.Graph()
    for node in graph.nodes:
        nx_graph.add_node(node.id)
    for edge in graph.edges:
        if edge.source == edge.target:
            continue
        weight = edge.weight if edge.weight > 0 else 1.0
        if nx_graph.has_edge(edge.source, edge.target):
            # Parallel edges (e.g. authored_by + co_authored between the same
            # pair) reinforce the tie rather than being dropped.
            nx_graph[edge.source][edge.target]["weight"] += weight
        else:
            nx_graph.add_edge(edge.source, edge.target, weight=weight)

    try:
        # Fixed seed → deterministic partition across reads of the same graph.
        communities = louvain_communities(nx_graph, weight="weight", seed=42)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("assign_communities: louvain failed: %s", exc)
        for node in graph.nodes:
            node.data["community"] = 0
        return 1

    ordered = sorted((set(c) for c in communities), key=len, reverse=True)
    membership: dict[str, int] = {}
    for index, members in enumerate(ordered):
        for node_id in members:
            membership[node_id] = index

    for node in graph.nodes:
        node.data["community"] = membership.get(node.id, 0)

    return len(ordered)
