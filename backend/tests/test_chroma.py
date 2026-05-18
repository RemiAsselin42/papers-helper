"""Tests for the per-project Chroma client/collection management."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from app import chroma as chroma_mod
from app.chroma import evict_collection, get_collection


def test_evict_then_get_collection_rebuilds_cleanly(tmp_path: Path) -> None:
    """Regression: evict_collection stopped the Chroma system but left it in
    Chroma's process-wide registry, so the next PersistentClient on the same
    path reused the *stopped* system → "Could not connect to tenant
    default_tenant". After eviction, get_collection must rebuild a working one.
    """
    with (
        patch.object(chroma_mod, "PROJECTS_DIR", tmp_path),
        patch("app.settings.PROJECTS_DIR", tmp_path),
    ):
        col = get_collection("proj-x")
        # Explicit embeddings → the Ollama embed function is never invoked.
        col.add(ids=["a"], documents=["hello"], embeddings=[[0.1, 0.2]])
        assert col.count() == 1

        evict_collection("proj-x")

        # Must not raise — a fresh, running system is rebuilt.
        col_again = get_collection("proj-x")
        assert col_again.count() == 1
