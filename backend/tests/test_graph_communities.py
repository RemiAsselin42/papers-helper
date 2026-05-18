"""Tests for Louvain community assignment over the knowledge graph.

These never touch Chroma or the LLM — `assign_communities` is a pure function
over an in-memory Graph.
"""

from __future__ import annotations

from collections import Counter

from app.graph.communities import assign_communities
from app.graph.schema import Graph, GraphEdge, GraphNode


def _node(node_id: str, type_: str = "paper") -> GraphNode:
    return GraphNode(id=node_id, type=type_, label=node_id)  # type: ignore[arg-type]


class TestAssignCommunities:
    def test_empty_graph_returns_zero(self) -> None:
        assert assign_communities(Graph.empty()) == 0

    def test_every_node_gets_an_int_community(self) -> None:
        graph = Graph(
            nodes=[_node("paper:a"), _node("author:x", "author")],
            edges=[GraphEdge(source="paper:a", target="author:x", type="authored_by")],
        )
        assign_communities(graph)
        for node in graph.nodes:
            assert isinstance(node.data["community"], int)

    def test_disconnected_components_get_distinct_communities(self) -> None:
        graph = Graph(
            nodes=[
                _node("paper:a"),
                _node("author:x", "author"),
                _node("paper:b"),
                _node("author:y", "author"),
            ],
            edges=[
                GraphEdge(source="paper:a", target="author:x", type="authored_by"),
                GraphEdge(source="paper:b", target="author:y", type="authored_by"),
            ],
        )
        count = assign_communities(graph)
        assert count == 2
        by_id = {n.id: n.data["community"] for n in graph.nodes}
        assert by_id["paper:a"] == by_id["author:x"]
        assert by_id["paper:b"] == by_id["author:y"]
        assert by_id["paper:a"] != by_id["paper:b"]

    def test_community_zero_is_the_largest(self) -> None:
        # Larger component (4 nodes) + smaller one (2 nodes). Community 0 must
        # be at least as big as every other, regardless of how Louvain splits.
        graph = Graph(
            nodes=[_node(f"paper:{c}") for c in "abcdef"],
            edges=[
                GraphEdge(source="paper:a", target="paper:b", type="semantic"),
                GraphEdge(source="paper:b", target="paper:c", type="semantic"),
                GraphEdge(source="paper:c", target="paper:d", type="semantic"),
                GraphEdge(source="paper:d", target="paper:a", type="semantic"),
                GraphEdge(source="paper:e", target="paper:f", type="semantic"),
            ],
        )
        assign_communities(graph)
        sizes = Counter(n.data["community"] for n in graph.nodes)
        assert all(sizes[0] >= sizes[c] for c in sizes)

    def test_deterministic_across_runs(self) -> None:
        def build() -> Graph:
            return Graph(
                nodes=[_node("paper:a"), _node("paper:b"), _node("paper:c")],
                edges=[
                    GraphEdge(source="paper:a", target="paper:b", type="semantic"),
                    GraphEdge(source="paper:b", target="paper:c", type="semantic"),
                ],
            )

        g1, g2 = build(), build()
        assign_communities(g1)
        assign_communities(g2)
        assert {n.id: n.data["community"] for n in g1.nodes} == {
            n.id: n.data["community"] for n in g2.nodes
        }
