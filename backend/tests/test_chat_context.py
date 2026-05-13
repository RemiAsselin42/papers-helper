"""Tests for context injection in the chat endpoint:
- problematique formatting as a system message
- mention retrieval with short-doc fallback and top-k + neighbors
- opt-in global RAG over the whole corpus

`read_problematique_sync` and `get_collection` are looked up from
`app.routes.chat.context` (where the retrieval helpers live); the
`OllamaGenerationService` import lives in `app.routes.chat.routes`.
Mention-syntax rewriting (`@Type/file` → `« file »`) is the frontend's
responsibility — see `frontend/src/utils/mentions.test.ts`.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routes.chat import (
    SHORT_DOC_CHUNK_THRESHOLD,
    _format_problematique_context,
)
from app.routes.projects import Approach, Hypothesis, Problematique


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


def _capture_factory() -> tuple[dict[str, Any], Any]:
    """Helper: return (captured_dict, async_capture_fn) for patching the
    OllamaGenerationService stream method. The captured dict gets a
    `messages` key populated on first call."""
    captured: dict[str, Any] = {}

    async def _capture(_self: Any, messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
        captured["messages"] = messages
        yield "ok"

    return captured, _capture


# ---------------------------------------------------------------------------
# _format_problematique_context unit tests (no HTTP)
# ---------------------------------------------------------------------------


def test_problematique_empty_returns_none() -> None:
    """An empty problematique must produce no system message."""
    with patch(
        "app.routes.chat.context.read_problematique_sync",
        return_value=Problematique(),
    ):
        assert _format_problematique_context("p1") is None


def test_problematique_partial_skips_empty_sections() -> None:
    """Only filled fields appear in the rendered Markdown."""
    problem = Problematique(
        research_problem="Pourquoi X arrive ?",
        sub_research_problem="",
        hypotheses=[],
        planned_approaches=[],
        expected_outcomes="",
    )
    with patch("app.routes.chat.context.read_problematique_sync", return_value=problem):
        rendered = _format_problematique_context("p1")
    assert rendered is not None
    assert "## Problème de recherche" in rendered
    assert "Pourquoi X arrive ?" in rendered
    assert "## Sous-problème" not in rendered
    assert "## Hypothèses" not in rendered
    assert "## Approches envisagées" not in rendered
    assert "## Résultats attendus" not in rendered


def test_problematique_full_renders_all_sections() -> None:
    problem = Problematique(
        research_problem="RP",
        sub_research_problem="SRP",
        hypotheses=[
            Hypothesis(text="H1", sub_hypotheses=["H1a", "H1b"]),
            Hypothesis(text="H2", sub_hypotheses=[]),
            Hypothesis(text="", sub_hypotheses=[""]),  # filtered out
        ],
        planned_approaches=[Approach(title="A1", text="A1 body")],
        expected_outcomes="EO",
    )
    with patch("app.routes.chat.context.read_problematique_sync", return_value=problem):
        rendered = _format_problematique_context("p1")
    assert rendered is not None
    assert "RP" in rendered
    assert "SRP" in rendered
    assert "1. H1" in rendered
    assert "   - H1a" in rendered
    assert "   - H1b" in rendered
    assert "2. H2" in rendered
    # Empty hypothesis must not produce an entry.
    assert "3." not in rendered
    assert "### A1" in rendered
    assert "A1 body" in rendered
    assert "EO" in rendered


def test_problematique_io_error_swallowed() -> None:
    """A malformed problematique file must not crash the chat handler."""
    with patch(
        "app.routes.chat.context.read_problematique_sync",
        side_effect=OSError("boom"),
    ):
        assert _format_problematique_context("p1") is None


# ---------------------------------------------------------------------------
# End-to-end injection through the /chat route
# ---------------------------------------------------------------------------


def _short_doc_collection(stem: str, n_chunks: int) -> Any:
    """Build a fake collection holding a single short document."""
    docs = [f"chunk {i} of {stem}" for i in range(n_chunks)]
    metas = [
        {
            "chunk_index": i,
            "chunk_total": n_chunks,
            "source_filename": f"{stem}.pdf",
            "source_type": "pdf",
            "source_stem": stem,
        }
        for i in range(n_chunks)
    ]

    class _Fake:
        def get(self, **_kwargs: Any) -> dict[str, Any]:
            # Returns full doc regardless of where filter — the chat handler
            # only ever asks about this stem in this test.
            return {
                "ids": [f"{stem}-{i}" for i in range(n_chunks)],
                "documents": docs,
                "metadatas": metas,
            }

        def query(self, **_kwargs: Any) -> dict[str, Any]:  # pragma: no cover
            raise AssertionError("short-doc path must not invoke .query()")

    return _Fake()


def test_problematique_injected_when_no_mention(client: TestClient) -> None:
    """Without any mention or global RAG, a non-empty problematique is still
    injected as the leading system message."""
    captured, capture = _capture_factory()
    problem = Problematique(research_problem="Étudier Y")
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=problem),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            json={"model": "llama3", "messages": [{"role": "user", "content": "salut"}]},
        )
    assert response.status_code == 200
    msgs = captured["messages"]
    assert msgs[0]["role"] == "system"
    assert "Étudier Y" in msgs[0]["content"]
    assert msgs[-1] == {"role": "user", "content": "salut"}


def test_short_mention_uses_full_doc(client: TestClient) -> None:
    captured, capture = _capture_factory()
    fake = _short_doc_collection("paper-a", n_chunks=3)
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "paper-a"},
            json={"model": "llama3", "messages": [{"role": "user", "content": "résume"}]},
        )
    assert response.status_code == 200
    msgs = captured["messages"]
    assert msgs[0]["role"] == "system"
    body = msgs[0]["content"]
    assert "DÉBUT DU CONTENU : paper-a.pdf" in body
    assert "FIN DU CONTENU : paper-a.pdf" in body
    for i in range(3):
        assert f"chunk {i} of paper-a" in body


class _LongDocFakeCollection:
    """Fake collection holding a long document (> SHORT_DOC_CHUNK_THRESHOLD).

    Tracks the calls made to it so tests can assert that the top-k path was
    taken and neighbor expansion fired (or didn't).
    """

    def __init__(self, stem: str, n_total: int, topk_indices: list[int]) -> None:
        self.stem = stem
        self.n_total = n_total
        self.topk_indices = topk_indices
        self.get_calls: list[dict[str, Any]] = []
        self.query_calls: list[dict[str, Any]] = []

    def _metas(self, indices: list[int]) -> list[dict[str, Any]]:
        return [
            {
                "chunk_index": i,
                "chunk_total": self.n_total,
                "source_filename": f"{self.stem}.pdf",
                "source_type": "pdf",
                "source_stem": self.stem,
            }
            for i in indices
        ]

    def get(self, **kwargs: Any) -> dict[str, Any]:
        self.get_calls.append(kwargs)
        where = kwargs.get("where") or {}
        # Initial count pass: filter by stem only.
        if "source_stem" in where and "$and" not in where:
            indices = list(range(self.n_total))
            return {
                "ids": [f"{self.stem}-{i}" for i in indices],
                "documents": [f"doc-{i}" for i in indices],
                "metadatas": self._metas(indices),
            }
        # Neighbor expansion pass: $and over stem + chunk_index $in.
        if "$and" in where:
            wanted: list[int] = []
            for clause in where["$and"]:
                if "chunk_index" in clause:
                    wanted = list(clause["chunk_index"]["$in"])
            indices = sorted(i for i in wanted if 0 <= i < self.n_total)
            return {
                "ids": [f"{self.stem}-{i}" for i in indices],
                "documents": [f"doc-{i}" for i in indices],
                "metadatas": self._metas(indices),
            }
        return {"ids": [], "documents": [], "metadatas": []}

    def query(self, **kwargs: Any) -> dict[str, Any]:
        self.query_calls.append(kwargs)
        return {
            "ids": [[f"{self.stem}-{i}" for i in self.topk_indices]],
            "documents": [[f"doc-{i}" for i in self.topk_indices]],
            "metadatas": [self._metas(self.topk_indices)],
        }


def test_long_mention_uses_topk_with_neighbors(client: TestClient) -> None:
    """A mention on a long document must trigger collection.query() and, by
    default, also fetch adjacent chunks via collection.get()."""
    captured, capture = _capture_factory()
    n_total = SHORT_DOC_CHUNK_THRESHOLD + 5
    fake = _LongDocFakeCollection("long-paper", n_total=n_total, topk_indices=[3, 8])
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "long-paper"},
            json={
                "model": "llama3",
                "messages": [{"role": "user", "content": "quelle est la conclusion ?"}],
            },
        )
    assert response.status_code == 200
    assert fake.query_calls, ".query() must have been called for a long doc"
    # The second .get() (after the count pass) must include neighbor indices.
    neighbor_indices_seen: set[int] = set()
    for call in fake.get_calls:
        where = call.get("where") or {}
        if "$and" in where:
            for clause in where["$and"]:
                if "chunk_index" in clause:
                    neighbor_indices_seen.update(clause["chunk_index"]["$in"])
    # Neighbors of {3, 8} are {2, 3, 4, 7, 8, 9}.
    assert {2, 4, 7, 9}.issubset(neighbor_indices_seen)
    body = captured["messages"][0]["content"]
    # All neighbor docs must appear in the rendered section.
    for i in (2, 3, 4, 7, 8, 9):
        assert f"doc-{i}" in body
    # Chunks far from any hit must not appear.
    assert "doc-0" not in body
    assert f"doc-{n_total - 1}" not in body


def test_long_mention_without_neighbors_uses_only_topk(client: TestClient) -> None:
    """When X-Chat-Neighbor-Chunks=0, only the top-k chunks are injected."""
    captured, capture = _capture_factory()
    n_total = SHORT_DOC_CHUNK_THRESHOLD + 5
    fake = _LongDocFakeCollection("long-paper", n_total=n_total, topk_indices=[3, 8])
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "long-paper", "X-Chat-Neighbor-Chunks": "0"},
            json={"model": "llama3", "messages": [{"role": "user", "content": "?"}]},
        )
    assert response.status_code == 200
    # The neighbor-expansion .get() (the one with $and) must NOT have fired.
    for call in fake.get_calls:
        assert "$and" not in (call.get("where") or {})
    body = captured["messages"][0]["content"]
    assert "doc-3" in body
    assert "doc-8" in body
    # Adjacent chunks must NOT appear when the toggle is off.
    assert "doc-2" not in body
    assert "doc-4" not in body


def test_global_rag_injected_when_opted_in(client: TestClient) -> None:
    """When X-Chat-Global-Rag=1, the chat handler injects a semantic-search
    block over the whole project collection — without any mention required."""
    captured, capture = _capture_factory()

    class _GlobalFake:
        def __init__(self) -> None:
            self.query_calls: list[dict[str, Any]] = []

        def get(self, **_kwargs: Any) -> dict[str, Any]:
            return {"ids": [], "documents": [], "metadatas": []}

        def query(self, **kwargs: Any) -> dict[str, Any]:
            self.query_calls.append(kwargs)
            return {
                "ids": [["a-0", "b-0"]],
                "documents": [["passage A", "passage B"]],
                "metadatas": [
                    [
                        {
                            "chunk_index": 0,
                            "chunk_total": 5,
                            "source_filename": "a.pdf",
                            "source_stem": "a",
                            "source_type": "pdf",
                        },
                        {
                            "chunk_index": 0,
                            "chunk_total": 3,
                            "source_filename": "b.pdf",
                            "source_stem": "b",
                            "source_type": "pdf",
                        },
                    ]
                ],
            }

    fake = _GlobalFake()
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Global-Rag": "1"},
            json={
                "model": "llama3",
                "messages": [{"role": "user", "content": "qu'est-ce que X ?"}],
            },
        )
    assert response.status_code == 200
    assert fake.query_calls, "global RAG must invoke collection.query()"
    # The query() must not be scoped by a where filter — it searches the whole
    # collection.
    assert fake.query_calls[0].get("where") is None
    body = captured["messages"][0]["content"]
    assert "passage A" in body
    assert "passage B" in body
    assert "a.pdf" in body
    assert "b.pdf" in body


def test_global_rag_skipped_when_not_opted_in(client: TestClient) -> None:
    """Default behaviour: no global RAG header means no .query() over the
    whole corpus."""
    captured, capture = _capture_factory()

    class _GlobalFake:
        def __init__(self) -> None:
            self.query_calls: list[dict[str, Any]] = []

        def get(self, **_kwargs: Any) -> dict[str, Any]:
            return {"ids": [], "documents": [], "metadatas": []}

        def query(self, **kwargs: Any) -> dict[str, Any]:
            self.query_calls.append(kwargs)
            return {"ids": [[]], "documents": [[]], "metadatas": [[]]}

    fake = _GlobalFake()
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            json={"model": "llama3", "messages": [{"role": "user", "content": "salut"}]},
        )
    assert response.status_code == 200
    assert not fake.query_calls, "global RAG must stay off without opt-in"
    # The user message reaches the model untouched (no leading system block).
    assert captured["messages"] == [{"role": "user", "content": "salut"}]


def test_backend_does_not_rewrite_mention_syntax(client: TestClient) -> None:
    """Confirm the backend no longer applies a regex pass on `@Type/file`
    tokens. Detoxification is the frontend's responsibility — the backend
    forwards the user's content verbatim. This guards against accidental
    re-introduction of a second rewriter that could diverge from the
    frontend implementation."""
    captured, capture = _capture_factory()
    fake = _short_doc_collection("paper-a", n_chunks=2)
    with (
        patch("app.routes.chat.context.read_problematique_sync", return_value=Problematique()),
        patch("app.routes.chat.context.get_collection", return_value=fake),
        patch(
            "app.routes.chat.routes.OllamaGenerationService.stream_generate_messages", new=capture
        ),
    ):
        response = client.post(
            "/projects/p1/chat",
            headers={"X-Chat-Mentions": "paper-a"},
            json={
                "model": "llama3",
                "messages": [{"role": "user", "content": "résume @Pdf/paper-a.pdf stp"}],
            },
        )
    assert response.status_code == 200
    user_msg = captured["messages"][-1]
    assert user_msg["role"] == "user"
    # The raw token must reach the model unchanged. The frontend would have
    # rewritten it before sending in real traffic; this test sends raw input
    # to assert the backend never strips on its own.
    assert user_msg["content"] == "résume @Pdf/paper-a.pdf stp"
