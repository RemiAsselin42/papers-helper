"""Per-project knowledge graph.

Public surface consumed by routes and by features that query the graph
(Citations, Similarité, Aide à la rédaction). Internals are split across
modules so individual pieces stay testable in isolation:

- `schema`: node/edge dataclasses and stable ID helpers
- `storage`: atomic JSON read/write + per-project asyncio locks
- `build`: pure derivations from sidecar metadata
- `semantic`: Chroma-backed mean embedding + nearest-neighbour search
- `concepts`: best-effort LLM keyword extraction (cached in sidecar)
- `builder`: async orchestrators (add/remove/update/rebuild)
- `queries`: read-only helpers for consumer features

Hooks into ingestion live in `app.ingestion` and `app.routes.papers`.
"""

from app.graph.builder import (
    graph_add_source,
    graph_rebuild,
    graph_remove_source,
    graph_sync,
    graph_update_source,
)
from app.graph.schema import (
    Graph,
    GraphEdge,
    GraphNode,
    author_node_id,
    concept_node_id,
    paper_node_id,
    slug_author,
    slug_concept,
    slug_theme,
    theme_node_id,
)
from app.graph.storage import (
    GRAPH_SCHEMA_VERSION,
    GraphSchemaMismatchError,
    evict_graph_lock,
    get_lock,
    graph_path,
    read_graph,
    write_graph_atomic,
)

__all__ = [
    "GRAPH_SCHEMA_VERSION",
    "Graph",
    "GraphEdge",
    "GraphNode",
    "GraphSchemaMismatchError",
    "author_node_id",
    "concept_node_id",
    "evict_graph_lock",
    "get_lock",
    "graph_add_source",
    "graph_path",
    "graph_rebuild",
    "graph_remove_source",
    "graph_sync",
    "graph_update_source",
    "paper_node_id",
    "read_graph",
    "slug_author",
    "slug_concept",
    "slug_theme",
    "theme_node_id",
    "write_graph_atomic",
]
