"""HTTP surface for the knowledge graph.

- `GET  /projects/{id}/graph`               → JSON dump (nodes, edges, stats).
- `GET  /projects/{id}/graph/neighbors/{id}` → sub-graph around one node.
- `POST /projects/{id}/graph/rebuild`       → SSE stream re-deriving the entire
                                               graph from the sources on disk.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import PROJECTS_DIR
from app.graph import (
    GRAPH_SCHEMA_VERSION,
    GraphSchemaMismatchError,
    graph_rebuild,
    graph_sync,
    read_graph,
)
from app.graph.build import graph_stats
from app.graph.builder import SEMANTIC_THRESHOLD
from app.graph.communities import assign_communities
from app.graph.queries import neighborhood
from app.ingestion import iter_source_files

router = APIRouter(prefix="/projects/{project_id}/graph", tags=["graph"])


class GraphNodeResponse(BaseModel):
    id: str
    type: str
    label: str
    data: dict[str, Any] = {}


class GraphEdgeResponse(BaseModel):
    source: str
    target: str
    type: str
    weight: float = 1.0


class GraphResponse(BaseModel):
    version: int = GRAPH_SCHEMA_VERSION
    embed_model: str = ""
    updated_at: str = ""
    nodes: list[GraphNodeResponse] = []
    edges: list[GraphEdgeResponse] = []
    stats: dict[str, Any] = {}
    # True iff `graph.json` exists but declares an unsupported schema version.
    # The frontend uses this to nudge the user to rebuild rather than silently
    # showing an empty graph.
    corrupt: bool = False
    # How many source files on disk have a sidecar. The frontend compares this
    # to the count of `paper` nodes to know whether a background sync is
    # needed (e.g. after legacy projects skipped the per-ingestion hook).
    source_count: int = 0
    # Similarity threshold used by the backend when materialising semantic
    # edges. Exposed so the frontend's filter slider seeds from the same
    # source of truth instead of duplicating the constant.
    semantic_threshold: float = SEMANTIC_THRESHOLD
    # Number of Louvain communities found on this read. Each node carries its
    # own `data["community"]` index; this is exposed so the UI can size a
    # legend without scanning every node.
    community_count: int = 0


class GraphNeighborsResponse(BaseModel):
    """Sub-graph returned by `GET /graph/neighbors/{node_id}` — the centre
    node plus everything within `depth` hops."""

    node_id: str
    depth: int = 1
    nodes: list[GraphNodeResponse] = []
    edges: list[GraphEdgeResponse] = []


def _check_project_exists(project_id: str) -> None:
    if not (PROJECTS_DIR / project_id).exists():
        raise HTTPException(status_code=404, detail="Project not found")


@router.get("", response_model=GraphResponse)
async def get_graph(project_id: str) -> GraphResponse:
    _check_project_exists(project_id)

    def _fetch() -> GraphResponse:
        # How many source files on disk are eligible to become graph nodes.
        # Counts everything `iter_source_files` returns — the sync path
        # synthesises sidecars for files imported before the graph feature
        # shipped, so missing-sidecar isn't a disqualifier here.
        source_count = 0
        try:
            project_dir = PROJECTS_DIR / project_id
            source_count = len(iter_source_files(project_dir))
        except Exception:
            pass

        try:
            graph = read_graph(project_id)
        except GraphSchemaMismatchError:
            return GraphResponse(
                corrupt=True,
                source_count=source_count,
                semantic_threshold=SEMANTIC_THRESHOLD,
            )
        # Communities are a derived view, not persisted: computing on read
        # keeps them consistent with the current node/edge set and lets
        # graphs built before this feature shipped light up without a rebuild.
        community_count = assign_communities(graph)
        return GraphResponse(
            version=graph.version,
            embed_model=graph.embed_model,
            updated_at=graph.updated_at,
            nodes=[
                GraphNodeResponse(id=n.id, type=n.type, label=n.label, data=n.data)
                for n in graph.nodes
            ],
            edges=[
                GraphEdgeResponse(source=e.source, target=e.target, type=e.type, weight=e.weight)
                for e in graph.edges
            ],
            stats=graph_stats(graph),
            source_count=source_count,
            semantic_threshold=SEMANTIC_THRESHOLD,
            community_count=community_count,
        )

    return await asyncio.to_thread(_fetch)


@router.get("/neighbors/{node_id:path}", response_model=GraphNeighborsResponse)
async def get_neighbors(
    project_id: str,
    node_id: str,
    depth: int = Query(default=1, ge=1, le=5),
) -> GraphNeighborsResponse:
    """Return the sub-graph within *depth* hops of *node_id*.

    `node_id` is a `type:slug` identifier (e.g. `paper:my-doc`); the `:path`
    converter keeps any slashes a stem might contain intact. 404 if the node
    is absent from the graph.
    """
    _check_project_exists(project_id)

    def _fetch() -> GraphNeighborsResponse:
        nodes, edges = neighborhood(project_id, node_id, depth)
        if not nodes:
            raise HTTPException(status_code=404, detail="Node not found in graph")
        return GraphNeighborsResponse(
            node_id=node_id,
            depth=depth,
            nodes=[
                GraphNodeResponse(id=n.id, type=n.type, label=n.label, data=n.data) for n in nodes
            ],
            edges=[
                GraphEdgeResponse(source=e.source, target=e.target, type=e.type, weight=e.weight)
                for e in edges
            ],
        )

    return await asyncio.to_thread(_fetch)


@router.post("/rebuild")
async def rebuild_graph(project_id: str) -> StreamingResponse:
    _check_project_exists(project_id)
    return StreamingResponse(
        graph_rebuild(project_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/sync")
async def sync_graph(project_id: str) -> StreamingResponse:
    """Add already-imported sources to the graph without wiping. Safe to call
    repeatedly (idempotent) — the frontend fires this fire-and-forget when
    the Graph view mounts so legacy / out-of-band sources get represented."""
    _check_project_exists(project_id)
    return StreamingResponse(
        graph_sync(project_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
