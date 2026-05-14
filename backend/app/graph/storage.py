"""Atomic JSON storage and per-project locking for the knowledge graph.

The graph lives at `<DATA_DIR>/projects/<uuid>/graph.json`. Writes go through
`os.replace` after a tmp file so a crash mid-write can never leave a corrupted
file in place. Concurrent writers serialise on a per-project `asyncio.Lock`
(same pattern as `app.chroma`'s per-project collection cache).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from app.config import PROJECTS_DIR
from app.graph.schema import Graph, GraphEdge, GraphNode

log = logging.getLogger(__name__)

GRAPH_SCHEMA_VERSION = 1
GRAPH_FILENAME = "graph.json"


class GraphSchemaMismatchError(Exception):
    """Raised when graph.json declares a version this build doesn't understand."""


_locks: dict[str, asyncio.Lock] = {}


def graph_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / GRAPH_FILENAME


def get_lock(project_id: str) -> asyncio.Lock:
    """Return the per-project graph write lock, creating it on first call.

    Lookups are O(1). Tests and the project-delete path use `evict_graph_lock`
    to discard the entry when the project goes away.
    """
    lock = _locks.get(project_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[project_id] = lock
    return lock


def evict_graph_lock(project_id: str) -> None:
    _locks.pop(project_id, None)


def read_graph(project_id: str) -> Graph:
    """Load the project graph. Returns an empty graph if the file is absent or
    unparseable; raises GraphSchemaMismatchError if the version is in the
    future. Missing/corrupt is *not* an error — the caller (rebuild) can
    recover by writing fresh data."""
    path = graph_path(project_id)
    if not path.exists():
        return Graph.empty()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("graph.json unreadable for project %s: %s — returning empty", project_id, exc)
        return Graph.empty()

    if not isinstance(raw, dict):
        log.warning("graph.json has unexpected shape for project %s — returning empty", project_id)
        return Graph.empty()

    version = int(raw.get("version", 0) or 0)
    if version > GRAPH_SCHEMA_VERSION:
        raise GraphSchemaMismatchError(
            f"graph.json version {version} > supported {GRAPH_SCHEMA_VERSION}"
        )

    nodes_raw = raw.get("nodes") or []
    edges_raw = raw.get("edges") or []
    try:
        nodes = [GraphNode.from_dict(n) for n in nodes_raw if isinstance(n, dict)]
        edges = [GraphEdge.from_dict(e) for e in edges_raw if isinstance(e, dict)]
    except (KeyError, TypeError, ValueError) as exc:
        log.warning("graph.json entries malformed for %s: %s — returning empty", project_id, exc)
        return Graph.empty()

    return Graph(
        version=version or GRAPH_SCHEMA_VERSION,
        embed_model=str(raw.get("embed_model", "")),
        updated_at=str(raw.get("updated_at", "")),
        nodes=nodes,
        edges=edges,
    )


def write_graph_atomic(project_id: str, graph: Graph) -> None:
    """Serialise + atomic replace. The project dir is created if missing so
    callers don't have to remember to mkdir."""
    path = graph_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = graph.to_dict()
    payload["version"] = GRAPH_SCHEMA_VERSION
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)
