"""HTTP surface for the knowledge graph.

- `GET  /projects/{id}/graph`         → JSON dump (nodes, edges, stats).
- `POST /projects/{id}/graph/rebuild` → SSE stream re-deriving the entire graph
                                         from the sources currently on disk.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
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
