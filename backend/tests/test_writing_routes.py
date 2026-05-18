"""HTTP-level tests for the writing assistant — /projects/{id}/writing.

Documents are a per-project collection of JSON files (mirrors conversations).
The generation endpoint streams tokens from Ollama; conftest's ollama stub
returns a non-iterable mock for `chat`, so the streaming tests monkeypatch
`OllamaGenerationService.stream_generate_messages` with a real async generator.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Generator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.chroma import evict_collection, get_collection
from app.main import app
from app.ollama_service import OllamaGenerationService

_QUERY_VEC = [0.1, 0.2, 0.3]


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj"
    (d / "files").mkdir(parents=True)
    return d


@pytest.fixture(autouse=True)
def _patch_projects_dir(project_dir: Path) -> Generator[None, None, None]:
    evict_collection(project_dir.name)
    with (
        patch("app.routes.writing.PROJECTS_DIR", project_dir.parent),
        patch("app.routes.projects.PROJECTS_DIR", project_dir.parent),
        patch("app.chroma.PROJECTS_DIR", project_dir.parent),
        patch("app.settings.PROJECTS_DIR", project_dir.parent),
    ):
        yield
    evict_collection(project_dir.name)


@pytest.fixture
def fake_stream(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace Ollama streaming with a deterministic token sequence."""
    tokens = ["Un ", "passage ", "redige."]

    async def _fake(
        self: OllamaGenerationService, messages: list[Any]
    ) -> AsyncGenerator[str, None]:
        for tok in tokens:
            yield tok

    monkeypatch.setattr(OllamaGenerationService, "stream_generate_messages", _fake)
    return tokens


def _chunk_meta(stem: str, idx: int, total: int) -> dict[str, Any]:
    return {
        "source_stem": stem,
        "source_filename": f"{stem}.pdf",
        "chunk_index": idx,
        "chunk_total": total,
        "word_count": 100,
        "pdf_title": stem.title(),
        "author": "",
        "year": "2024",
    }


def _seed(project_id: str, rows: list[tuple[str, list[float], dict[str, Any]]]) -> None:
    col = get_collection(project_id)
    col.add(
        ids=[r[0] for r in rows],
        documents=[f"text of {r[0]}" for r in rows],
        embeddings=[r[1] for r in rows],
        metadatas=[r[2] for r in rows],
    )


def _create(client: TestClient, project: str, title: str | None = None) -> str:
    resp = client.post(f"/projects/{project}/writing/", json={"title": title} if title else {})
    assert resp.status_code == 201
    return resp.json()["id"]


class TestCrud:
    def test_404_when_project_missing(self, client: TestClient) -> None:
        assert client.get("/projects/nope/writing/").status_code == 404

    def test_list_empty_on_fresh_project(self, client: TestClient, project_dir: Path) -> None:
        resp = client.get(f"/projects/{project_dir.name}/writing/")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_create_returns_default_doc(self, client: TestClient, project_dir: Path) -> None:
        resp = client.post(f"/projects/{project_dir.name}/writing/", json={})
        assert resp.status_code == 201
        body = resp.json()
        assert body["id"]
        assert body["title"] == "Nouveau texte"
        assert body["content_html"] == ""
        assert body["citations"] == []

    def test_created_doc_appears_in_list(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        listed = client.get(f"/projects/{project_dir.name}/writing/").json()
        assert [d["id"] for d in listed] == [doc_id]

    def test_get_unknown_doc_404(self, client: TestClient, project_dir: Path) -> None:
        assert client.get(f"/projects/{project_dir.name}/writing/missing").status_code == 404

    def test_put_round_trips_content(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        payload = {
            "title": "Mon article",
            "content_html": "<p>Bonjour (Doe, 2024)</p>",
            "citations": [{"chunk_id": "p::0", "stem": "p", "author": "Doe", "year": "2024"}],
        }
        put = client.put(f"/projects/{project_dir.name}/writing/{doc_id}", json=payload)
        assert put.status_code == 200
        body = client.get(f"/projects/{project_dir.name}/writing/{doc_id}").json()
        assert body["title"] == "Mon article"
        assert body["content_html"] == "<p>Bonjour (Doe, 2024)</p>"
        assert body["citations"][0]["chunk_id"] == "p::0"

    def test_put_unknown_doc_404(self, client: TestClient, project_dir: Path) -> None:
        resp = client.put(
            f"/projects/{project_dir.name}/writing/missing",
            json={"title": "x", "content_html": "", "citations": []},
        )
        assert resp.status_code == 404

    def test_patch_renames(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        resp = client.patch(
            f"/projects/{project_dir.name}/writing/{doc_id}", json={"title": "Renommé"}
        )
        assert resp.status_code == 200
        assert resp.json()["title"] == "Renommé"

    def test_patch_empty_title_rejected(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        resp = client.patch(f"/projects/{project_dir.name}/writing/{doc_id}", json={"title": "   "})
        assert resp.status_code == 422

    def test_delete_removes_doc(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        assert client.delete(f"/projects/{project_dir.name}/writing/{doc_id}").status_code == 204
        assert client.get(f"/projects/{project_dir.name}/writing/{doc_id}").status_code == 404


class TestGenerate:
    def test_404_when_doc_missing(self, client: TestClient, project_dir: Path) -> None:
        resp = client.post(
            f"/projects/{project_dir.name}/writing/missing/generate",
            json={"model": "llama3"},
        )
        assert resp.status_code == 404

    def test_empty_model_rejected(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        resp = client.post(
            f"/projects/{project_dir.name}/writing/{doc_id}/generate", json={"model": "  "}
        )
        assert resp.status_code == 400

    def test_external_provider_rejected(self, client: TestClient, project_dir: Path) -> None:
        doc_id = _create(client, project_dir.name)
        resp = client.post(
            f"/projects/{project_dir.name}/writing/{doc_id}/generate",
            json={"model": "gpt-4"},
            headers={"X-LLM-Provider": "openai"},
        )
        assert resp.status_code == 400

    def test_streams_tokens_with_corpus(
        self, client: TestClient, project_dir: Path, fake_stream: list[str]
    ) -> None:
        _seed(project_dir.name, [("paper-a::0", _QUERY_VEC, _chunk_meta("paper-a", 0, 1))])
        doc_id = _create(client, project_dir.name)
        resp = client.post(
            f"/projects/{project_dir.name}/writing/{doc_id}/generate",
            json={"model": "llama3", "instructions": "introduction"},
        )
        assert resp.status_code == 200
        text = resp.text
        assert '"token"' in text
        for tok in fake_stream:
            assert tok in text
        assert "data: [DONE]" in text

    def test_streams_with_empty_collection(
        self, client: TestClient, project_dir: Path, fake_stream: list[str]
    ) -> None:
        doc_id = _create(client, project_dir.name)
        resp = client.post(
            f"/projects/{project_dir.name}/writing/{doc_id}/generate", json={"model": "llama3"}
        )
        assert resp.status_code == 200
        assert "data: [DONE]" in resp.text

    def test_generate_does_not_persist(
        self, client: TestClient, project_dir: Path, fake_stream: list[str]
    ) -> None:
        doc_id = _create(client, project_dir.name)
        client.post(
            f"/projects/{project_dir.name}/writing/{doc_id}/generate", json={"model": "llama3"}
        )
        # The generate endpoint streams only — the document content is untouched.
        body = client.get(f"/projects/{project_dir.name}/writing/{doc_id}").json()
        assert body["content_html"] == ""
