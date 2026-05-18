"""Schema-level invariants for the knowledge graph: stable slugs, ID prefixes,
JSON round-tripping of nodes/edges/graphs."""

from __future__ import annotations

from app.graph.schema import (
    Graph,
    GraphEdge,
    GraphNode,
    author_node_id,
    category_node_id,
    concept_node_id,
    paper_node_id,
    slug_author,
    slug_category,
    slug_concept,
)


class TestSlugAuthor:
    def test_basic_family_given(self) -> None:
        assert slug_author("Smith", "John") == "smith_j"

    def test_initial_only(self) -> None:
        assert slug_author("Smith", "J.") == "smith_j"

    def test_no_given(self) -> None:
        assert slug_author("Smith", "") == "smith"

    def test_diacritics_normalised(self) -> None:
        # Diacritics stripped via NFD so "Étienne" and "Etienne" collide.
        assert slug_author("Étienne", "Marc") == slug_author("Etienne", "Marc")

    def test_unicode_family(self) -> None:
        assert slug_author("Müller", "Hans") == "muller_h"

    def test_punctuation_collapsed(self) -> None:
        assert slug_author("O'Brien", "Sean") == "o_brien_s"

    def test_empty_family_returns_empty(self) -> None:
        assert slug_author("", "Anything") == ""

    def test_whitespace_only_given_treated_as_absent(self) -> None:
        assert slug_author("Smith", "   ") == "smith"

    def test_given_with_leading_non_alnum(self) -> None:
        # First *alphanumeric* character is used for the initial.
        assert slug_author("Smith", "-Jean") == "smith_j"


class TestSlugCategoryAndConcept:
    def test_category_lowercased(self) -> None:
        assert slug_category("Natural Language Processing") == "natural_language_processing"

    def test_concept_strips_diacritics(self) -> None:
        assert slug_concept("Réseau de neurones") == "reseau_de_neurones"

    def test_empty_string_returns_empty(self) -> None:
        assert slug_category("") == ""
        assert slug_concept("") == ""


class TestNodeIDs:
    def test_paper_id_prefix(self) -> None:
        assert paper_node_id("foo_2020").startswith("paper:")

    def test_author_id_empty_when_no_family(self) -> None:
        assert author_node_id("", "John") == ""

    def test_category_id_includes_slug(self) -> None:
        assert category_node_id("ML") == "category:ml"

    def test_concept_id_includes_slug(self) -> None:
        assert concept_node_id("Transformers") == "concept:transformers"


class TestRoundTrip:
    def test_node_round_trip(self) -> None:
        n = GraphNode(id="paper:abc", type="paper", label="Hello", data={"year": "2024"})
        restored = GraphNode.from_dict(n.to_dict())
        assert restored == n

    def test_edge_round_trip(self) -> None:
        e = GraphEdge(source="paper:a", target="author:b", type="authored_by", weight=2.5)
        restored = GraphEdge.from_dict(e.to_dict())
        assert restored == e

    def test_graph_empty(self) -> None:
        g = Graph.empty()
        d = g.to_dict()
        assert d["nodes"] == [] and d["edges"] == []
        assert d["version"] == 2

    def test_legacy_theme_node_migrated_on_read(self) -> None:
        # graph.json written before the rename used type "theme" / "theme_of".
        node = GraphNode.from_dict({"id": "theme:ml", "type": "theme", "label": "ML"})
        assert node.type == "category"
        edge = GraphEdge.from_dict({"source": "paper:a", "target": "theme:ml", "type": "theme_of"})
        assert edge.type == "category_of"
