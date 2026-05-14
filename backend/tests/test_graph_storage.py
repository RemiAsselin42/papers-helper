"""Storage round-trip, atomic replace, schema mismatch, and per-project lock."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Generator
from pathlib import Path
from unittest.mock import patch

import pytest

from app.graph import storage
from app.graph.schema import Graph, GraphEdge, GraphNode
from app.graph.storage import (
    GRAPH_SCHEMA_VERSION,
    GraphSchemaMismatchError,
    evict_graph_lock,
    get_lock,
    graph_path,
    read_graph,
    write_graph_atomic,
)


@pytest.fixture
def projects_dir(tmp_path: Path) -> Path:
    d = tmp_path / "projects"
    d.mkdir()
    return d


@pytest.fixture(autouse=True)
def _patch_projects_dir(projects_dir: Path) -> Generator[None, None, None]:
    with patch.object(storage, "PROJECTS_DIR", projects_dir):
        yield


def test_read_missing_returns_empty() -> None:
    g = read_graph("nonexistent")
    assert g.nodes == [] and g.edges == []
    assert g.version == 1


def test_write_then_read_round_trip(projects_dir: Path) -> None:
    pid = "p1"
    (projects_dir / pid).mkdir()
    g = Graph(
        version=GRAPH_SCHEMA_VERSION,
        embed_model="nomic-embed-text",
        updated_at="2026-01-01T00:00:00+00:00",
        nodes=[
            GraphNode(id="paper:a", type="paper", label="A", data={"year": "2024"}),
            GraphNode(id="author:smith_j", type="author", label="Smith, John"),
        ],
        edges=[GraphEdge(source="paper:a", target="author:smith_j", type="authored_by")],
    )
    write_graph_atomic(pid, g)
    restored = read_graph(pid)
    assert restored.embed_model == "nomic-embed-text"
    assert {n.id for n in restored.nodes} == {"paper:a", "author:smith_j"}
    assert restored.edges[0].type == "authored_by"


def test_atomic_replace_leaves_no_tmp_file(projects_dir: Path) -> None:
    pid = "p1"
    (projects_dir / pid).mkdir()
    g = Graph.empty()
    write_graph_atomic(pid, g)
    parent = graph_path(pid).parent
    tmp_files = list(parent.glob("*.tmp"))
    assert tmp_files == []


def test_corrupted_file_returns_empty(projects_dir: Path) -> None:
    pid = "p1"
    (projects_dir / pid).mkdir()
    graph_path(pid).write_text("{not valid json")
    g = read_graph(pid)
    assert g.nodes == [] and g.edges == []


def test_future_version_raises(projects_dir: Path) -> None:
    pid = "p1"
    (projects_dir / pid).mkdir()
    graph_path(pid).write_text(json.dumps({"version": 9999, "nodes": [], "edges": []}))
    with pytest.raises(GraphSchemaMismatchError):
        read_graph(pid)


def test_unexpected_shape_returns_empty(projects_dir: Path) -> None:
    pid = "p1"
    (projects_dir / pid).mkdir()
    graph_path(pid).write_text(json.dumps(["not", "a", "dict"]))
    g = read_graph(pid)
    assert g.nodes == [] and g.edges == []


def test_lock_returns_same_instance() -> None:
    a = get_lock("project-x")
    b = get_lock("project-x")
    assert a is b
    evict_graph_lock("project-x")


def test_lock_evicted_returns_fresh_instance() -> None:
    a = get_lock("project-x")
    evict_graph_lock("project-x")
    b = get_lock("project-x")
    assert a is not b
    evict_graph_lock("project-x")


def test_lock_actually_serialises_writers(projects_dir: Path) -> None:
    """Concurrent writers must observe the lock — second writer waits for first."""
    pid = "p-concurrent"
    (projects_dir / pid).mkdir()
    write_graph_atomic(pid, Graph.empty())

    order: list[str] = []

    async def writer(name: str, hold_ms: float) -> None:
        async with get_lock(pid):
            order.append(f"{name}:enter")
            await asyncio.sleep(hold_ms / 1000)
            order.append(f"{name}:exit")

    async def run() -> None:
        await asyncio.gather(writer("A", 30), writer("B", 0))

    asyncio.run(run())
    evict_graph_lock(pid)

    # A entered first and must fully exit before B enters.
    assert order == ["A:enter", "A:exit", "B:enter", "B:exit"]
