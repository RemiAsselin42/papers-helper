"""Pure-function tests for the graph build layer.

These never touch Chroma or the LLM — they exercise the derivation of
nodes/edges from a SidecarMeta and the merge/remove invariants that the
orchestrator relies on.
"""

from __future__ import annotations

import json

from app.graph.build import (
    derive_paper_contribution,
    graph_stats,
    merge_paper,
    parse_authors,
    parse_concepts_json,
    remove_paper,
    split_categories,
)
from app.graph.schema import (
    Graph,
    GraphEdge,
    author_node_id,
    concept_node_id,
    paper_node_id,
    theme_node_id,
)
from app.ingestion import SidecarMeta


def _meta(
    stem: str,
    *,
    pdf_title: str = "Some Title",
    authors: list[dict[str, str]] | None = None,
    categories: str = "",
    abstract: str = "",
    year: str = "2024",
) -> SidecarMeta:
    return SidecarMeta(
        stem=stem,
        filename=f"{stem}.pdf",
        pdf_title=pdf_title,
        author=" ; ".join(f"{a['family']}, {a['given']}".rstrip(", ") for a in (authors or [])),
        year=year,
        authors_json=json.dumps(authors or [], ensure_ascii=False),
        categories=categories,
        abstract=abstract,
    )


class TestSplitCategories:
    def test_splits_on_comma_and_semicolon(self) -> None:
        assert split_categories("AI, NLP; ML") == ["AI", "NLP", "ML"]

    def test_drops_empties_and_dedupes_casefolded(self) -> None:
        assert split_categories("AI, ai , ml,, ML") == ["AI", "ml"]

    def test_empty_input(self) -> None:
        assert split_categories("") == []
        assert split_categories(",,;,") == []


class TestParseAuthors:
    def test_authors_json_preferred(self) -> None:
        meta = _meta("a", authors=[{"family": "Smith", "given": "J."}])
        assert parse_authors(meta) == [{"family": "Smith", "given": "J."}]

    def test_falls_back_to_flat_author(self) -> None:
        meta = SidecarMeta(stem="x", filename="x.pdf", author="Smith, John ; Doe, Jane")
        assert parse_authors(meta) == [
            {"family": "Smith", "given": "John"},
            {"family": "Doe", "given": "Jane"},
        ]

    def test_empty(self) -> None:
        assert parse_authors(SidecarMeta(stem="x", filename="x.pdf")) == []


class TestParseConceptsJson:
    def test_valid_list(self) -> None:
        assert parse_concepts_json(json.dumps(["a", "b"])) == ["a", "b"]

    def test_strips_non_strings(self) -> None:
        assert parse_concepts_json(json.dumps(["a", 1, None, "b"])) == ["a", "b"]

    def test_invalid_json_returns_empty(self) -> None:
        assert parse_concepts_json("not json") == []

    def test_non_list_returns_empty(self) -> None:
        assert parse_concepts_json(json.dumps({"a": 1})) == []


class TestDerivePaperContribution:
    def test_paper_node_uses_pdf_title(self) -> None:
        meta = _meta("paper1", pdf_title="Awesome Paper")
        paper, _aux, _edges = derive_paper_contribution(meta, [])
        assert paper.id == paper_node_id("paper1")
        assert paper.label == "Awesome Paper"
        assert paper.type == "paper"

    def test_author_nodes_and_edges(self) -> None:
        meta = _meta(
            "p",
            authors=[
                {"family": "Smith", "given": "John"},
                {"family": "Doe", "given": "Jane"},
            ],
        )
        paper, aux, edges = derive_paper_contribution(meta, [])
        author_ids = {n.id for n in aux if n.type == "author"}
        assert author_node_id("Smith", "John") in author_ids
        assert author_node_id("Doe", "Jane") in author_ids
        assert sum(1 for e in edges if e.type == "authored_by") == 2

    def test_theme_split_and_edges(self) -> None:
        meta = _meta("p", categories="AI, NLP")
        _paper, aux, edges = derive_paper_contribution(meta, [])
        theme_ids = {n.id for n in aux if n.type == "theme"}
        assert theme_node_id("AI") in theme_ids
        assert theme_node_id("NLP") in theme_ids
        assert sum(1 for e in edges if e.type == "theme_of") == 2

    def test_concept_nodes_and_edges(self) -> None:
        meta = _meta("p")
        _paper, aux, edges = derive_paper_contribution(meta, ["Transformers", "BERT"])
        concept_ids = {n.id for n in aux if n.type == "concept"}
        assert concept_node_id("Transformers") in concept_ids
        assert concept_node_id("BERT") in concept_ids
        assert sum(1 for e in edges if e.type == "concept_of") == 2

    def test_empty_author_family_is_skipped(self) -> None:
        meta = _meta("p", authors=[{"family": "", "given": "Anon"}])
        _paper, aux, _edges = derive_paper_contribution(meta, [])
        assert all(n.type != "author" for n in aux)


class TestMergePaper:
    def _add(self, graph: Graph, meta: SidecarMeta, concepts: list[str] | None = None) -> None:
        paper, aux, aux_edges = derive_paper_contribution(meta, concepts or [])
        merge_paper(graph, paper, aux, aux_edges, [])

    def test_idempotent_replace(self) -> None:
        graph = Graph.empty()
        meta = _meta("p1", authors=[{"family": "Smith", "given": "J"}])
        self._add(graph, meta)
        self._add(graph, meta)
        node_ids = [n.id for n in graph.nodes]
        assert node_ids.count(paper_node_id("p1")) == 1
        assert node_ids.count(author_node_id("Smith", "J")) == 1

    def test_co_authored_edges_derived(self) -> None:
        graph = Graph.empty()
        self._add(
            graph,
            _meta(
                "p1",
                authors=[
                    {"family": "Smith", "given": "J"},
                    {"family": "Doe", "given": "K"},
                ],
            ),
        )
        co = [e for e in graph.edges if e.type == "co_authored"]
        assert len(co) == 1
        assert co[0].weight == 1.0

    def test_co_authored_weight_increments_with_shared_papers(self) -> None:
        graph = Graph.empty()
        authors = [
            {"family": "Smith", "given": "J"},
            {"family": "Doe", "given": "K"},
        ]
        self._add(graph, _meta("p1", authors=authors))
        self._add(graph, _meta("p2", authors=authors))
        co = [e for e in graph.edges if e.type == "co_authored"]
        assert len(co) == 1
        assert co[0].weight == 2.0

    def test_semantic_edges_dedupe_canonical(self) -> None:
        graph = Graph.empty()
        paper_a, _aux_a, _e_a = derive_paper_contribution(_meta("a"), [])
        paper_b, _aux_b, _e_b = derive_paper_contribution(_meta("b"), [])
        # First merge: A points at B with weight 0.7
        merge_paper(
            graph,
            paper_a,
            [],
            [],
            [GraphEdge(source=paper_a.id, target=paper_b.id, type="semantic", weight=0.7)],
        )
        # Second merge: B points back at A with higher weight 0.9 — must replace.
        merge_paper(
            graph,
            paper_b,
            [],
            [],
            [GraphEdge(source=paper_b.id, target=paper_a.id, type="semantic", weight=0.9)],
        )
        sem = [e for e in graph.edges if e.type == "semantic"]
        assert len(sem) == 1
        assert sem[0].weight == 0.9

    def test_self_semantic_edge_dropped(self) -> None:
        graph = Graph.empty()
        paper_a, _aux, _edges = derive_paper_contribution(_meta("a"), [])
        merge_paper(
            graph,
            paper_a,
            [],
            [],
            [GraphEdge(source=paper_a.id, target=paper_a.id, type="semantic", weight=1.0)],
        )
        assert not any(e.type == "semantic" for e in graph.edges)

    def test_author_aliases_accumulate(self) -> None:
        """Two papers crediting the same slugged author with different given
        forms ("J." vs "John") should merge under one node, both forms kept
        as aliases for later disambiguation."""
        graph = Graph.empty()
        self._add(graph, _meta("p1", authors=[{"family": "Smith", "given": "John"}]))
        self._add(graph, _meta("p2", authors=[{"family": "Smith", "given": "J."}]))
        author_id = author_node_id("Smith", "John")
        node = next(n for n in graph.nodes if n.id == author_id)
        aliases = node.data.get("aliases") or []
        givens = {a.get("given") for a in aliases if isinstance(a, dict)}
        assert "John" in givens
        assert "J." in givens


class TestRemovePaper:
    def test_removes_orphan_authors(self) -> None:
        graph = Graph.empty()
        meta = _meta("p1", authors=[{"family": "Smith", "given": "J"}])
        paper, aux, edges = derive_paper_contribution(meta, [])
        merge_paper(graph, paper, aux, edges, [])
        assert any(n.id == author_node_id("Smith", "J") for n in graph.nodes)
        remove_paper(graph, paper.id)
        assert graph.nodes == []
        assert graph.edges == []

    def test_keeps_authors_with_other_papers(self) -> None:
        graph = Graph.empty()
        authors = [{"family": "Smith", "given": "J"}]
        p1, a1, e1 = derive_paper_contribution(_meta("p1", authors=authors), [])
        p2, a2, e2 = derive_paper_contribution(_meta("p2", authors=authors), [])
        merge_paper(graph, p1, a1, e1, [])
        merge_paper(graph, p2, a2, e2, [])
        remove_paper(graph, p1.id)
        assert any(n.id == author_node_id("Smith", "J") for n in graph.nodes)
        assert any(n.id == p2.id for n in graph.nodes)

    def test_co_authored_recomputed_after_remove(self) -> None:
        graph = Graph.empty()
        a1 = [{"family": "Smith", "given": "J"}, {"family": "Doe", "given": "K"}]
        a2 = [{"family": "Smith", "given": "J"}, {"family": "Roe", "given": "M"}]
        p1, n1, e1 = derive_paper_contribution(_meta("p1", authors=a1), [])
        p2, n2, e2 = derive_paper_contribution(_meta("p2", authors=a2), [])
        merge_paper(graph, p1, n1, e1, [])
        merge_paper(graph, p2, n2, e2, [])
        # Two co_authored edges: Smith-Doe (from p1), Smith-Roe (from p2).
        assert sum(1 for e in graph.edges if e.type == "co_authored") == 2
        remove_paper(graph, p1.id)
        # After p1 removal only Smith-Roe should remain.
        co = [e for e in graph.edges if e.type == "co_authored"]
        assert len(co) == 1
        endpoints = {co[0].source, co[0].target}
        assert author_node_id("Smith", "J") in endpoints
        assert author_node_id("Roe", "M") in endpoints


class TestGraphStats:
    def test_counts_by_type(self) -> None:
        graph = Graph.empty()
        meta = _meta(
            "p1",
            authors=[{"family": "Smith", "given": "J"}],
            categories="AI",
        )
        paper, aux, edges = derive_paper_contribution(meta, ["Transformers"])
        merge_paper(graph, paper, aux, edges, [])
        stats = graph_stats(graph)
        assert stats["nodes"]["paper"] == 1
        assert stats["nodes"]["author"] == 1
        assert stats["nodes"]["theme"] == 1
        assert stats["nodes"]["concept"] == 1
        assert stats["node_total"] == 4
