"""Dataclasses and stable identifiers for the knowledge graph.

Node IDs are deterministic and human-inspectable so the JSON file stays
diffable across runs and so consumer features (Citations, Similarité,
Aide à la rédaction) can build identifiers without going through the graph
storage layer.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Literal

NodeType = Literal["paper", "author", "category", "concept"]
EdgeType = Literal["authored_by", "co_authored", "category_of", "concept_of", "semantic"]

# Node/edge type names used by graph.json files written before the
# theme→category rename (schema v1). Mapped on read so old projects load
# transparently under the current names; the next write re-stamps them.
_LEGACY_NODE_TYPES: dict[str, str] = {"theme": "category"}
_LEGACY_EDGE_TYPES: dict[str, str] = {"theme_of": "category_of"}


@dataclass
class GraphNode:
    id: str
    type: NodeType
    label: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "type": self.type, "label": self.label, "data": self.data}

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> GraphNode:
        data = raw.get("data") or {}
        raw_type = raw["type"]
        return cls(
            id=str(raw["id"]),
            type=_LEGACY_NODE_TYPES.get(raw_type, raw_type),
            label=str(raw.get("label", "")),
            data=dict(data) if isinstance(data, dict) else {},
        )


@dataclass
class GraphEdge:
    source: str
    target: str
    type: EdgeType
    weight: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "target": self.target,
            "type": self.type,
            "weight": self.weight,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> GraphEdge:
        raw_type = raw["type"]
        return cls(
            source=str(raw["source"]),
            target=str(raw["target"]),
            type=_LEGACY_EDGE_TYPES.get(raw_type, raw_type),
            weight=float(raw.get("weight", 1.0)),
        )


@dataclass
class Graph:
    version: int = 2
    embed_model: str = ""
    updated_at: str = ""
    nodes: list[GraphNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "embed_model": self.embed_model,
            "updated_at": self.updated_at,
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
        }

    @classmethod
    def empty(cls) -> Graph:
        return cls()


# ---------------------------------------------------------------------------
# Slug helpers — deterministic, idempotent, filesystem/URL safe
# ---------------------------------------------------------------------------


_SAFE_CHARS = re.compile(r"[^a-z0-9]+")


def _safe_slug(text: str) -> str:
    """Lowercase NFD-stripped ASCII slug. Non-alphanumeric runs become `_`."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFD", text)
    ascii_only = "".join(c for c in normalized if not unicodedata.combining(c))
    lowered = ascii_only.lower()
    collapsed = _SAFE_CHARS.sub("_", lowered).strip("_")
    return collapsed


def slug_author(family: str, given: str) -> str:
    """`family_initialgiven` — deterministic but coarse. Author aliases on the
    node carry the full forms for any later disambiguation."""
    fam = _safe_slug(family)
    if not fam:
        return ""
    initial = ""
    given_stripped = (given or "").strip()
    if given_stripped:
        # First alphanumeric character of the given name (handles "J." → "j").
        for c in given_stripped:
            if c.isalnum():
                initial = c.lower()
                break
    return f"{fam}_{initial}" if initial else fam


def slug_category(category: str) -> str:
    return _safe_slug(category)


def slug_concept(concept: str) -> str:
    return _safe_slug(concept)


# ---------------------------------------------------------------------------
# Node ID constructors — single source of truth for the `type:slug` convention
# ---------------------------------------------------------------------------


def paper_node_id(stem: str) -> str:
    return f"paper:{stem}"


def author_node_id(family: str, given: str) -> str:
    slug = slug_author(family, given)
    return f"author:{slug}" if slug else ""


def category_node_id(category: str) -> str:
    slug = slug_category(category)
    return f"category:{slug}" if slug else ""


def concept_node_id(concept: str) -> str:
    slug = slug_concept(concept)
    return f"concept:{slug}" if slug else ""
