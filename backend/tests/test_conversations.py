"""Tests for the per-project conversation history endpoints."""

from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    d = tmp_path / "proj1"
    d.mkdir()
    return d


def _payload(
    messages: list[dict[str, str]] | None = None,
    provider: str = "ollama",
    model: str = "llama3",
    title: str | None = None,
) -> dict[str, object]:
    body: dict[str, object] = {
        "provider": provider,
        "model": model,
        "messages": messages
        if messages is not None
        else [{"role": "user", "content": "Hello, this is a test message"}],
    }
    if title is not None:
        body["title"] = title
    return body


class TestConversationCRUD:
    def test_list_empty_returns_empty_list(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.get(f"/projects/{project_dir.name}/conversations/")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_missing_project_returns_404(self, client: TestClient, tmp_path: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", tmp_path):
            resp = client.get("/projects/does-not-exist/conversations/")
        assert resp.status_code == 404

    def test_create_auto_titles_from_first_user_message(
        self, client: TestClient, project_dir: Path
    ) -> None:
        msg = "Quels sont les meilleurs articles?"
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(messages=[{"role": "user", "content": msg}]),
            )
        assert resp.status_code == 201
        data = resp.json()
        assert data["title"] == msg
        assert data["provider"] == "ollama"
        assert data["model"] == "llama3"
        assert len(data["messages"]) == 1
        assert data["id"]
        # File written on disk
        path = project_dir / "conversations" / f"{data['id']}.json"
        assert path.exists()
        saved = json.loads(path.read_text(encoding="utf-8"))
        assert saved["title"] == data["title"]

    def test_create_truncates_long_titles(self, client: TestClient, project_dir: Path) -> None:
        long = "x" * 200
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(messages=[{"role": "user", "content": long}]),
            )
        assert resp.status_code == 201
        assert len(resp.json()["title"]) == 60

    def test_create_with_explicit_title(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(title="Mon titre"),
            )
        assert resp.status_code == 201
        assert resp.json()["title"] == "Mon titre"

    def test_create_falls_back_to_default_title_when_no_user_message(
        self, client: TestClient, project_dir: Path
    ) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(messages=[]),
            )
        assert resp.status_code == 201
        assert resp.json()["title"] == "Nouvelle conversation"

    def test_create_rejects_unknown_provider(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(provider="bogus"),
            )
        assert resp.status_code == 422

    def test_get_returns_full_conversation(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            created = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(),
            ).json()
            resp = client.get(f"/projects/{project_dir.name}/conversations/{created['id']}")
        assert resp.status_code == 200
        assert resp.json()["id"] == created["id"]

    def test_get_missing_returns_404(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.get(f"/projects/{project_dir.name}/conversations/missing-id")
        assert resp.status_code == 404

    def test_list_returns_summary_sorted_by_updated_at_desc(
        self, client: TestClient, project_dir: Path
    ) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            first = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(messages=[{"role": "user", "content": "First"}]),
            ).json()
            # Make updated_at strictly newer for the second one by writing again.
            second = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(
                    messages=[{"role": "user", "content": "Second"}],
                    model="other-model",
                ),
            ).json()
            # Touch second with a PUT to bump updated_at after first.
            client.put(
                f"/projects/{project_dir.name}/conversations/{second['id']}",
                json=_payload(
                    messages=[
                        {"role": "user", "content": "Second"},
                        {"role": "assistant", "content": "Hi"},
                    ],
                    model="other-model",
                ),
            )
            resp = client.get(f"/projects/{project_dir.name}/conversations/")

        assert resp.status_code == 200
        data = resp.json()
        assert [c["id"] for c in data] == [second["id"], first["id"]]
        assert data[0]["message_count"] == 2
        assert "messages" not in data[0]

    def test_put_updates_messages_and_bumps_updated_at(
        self, client: TestClient, project_dir: Path
    ) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            created = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(),
            ).json()
            resp = client.put(
                f"/projects/{project_dir.name}/conversations/{created['id']}",
                json=_payload(
                    messages=[
                        {"role": "user", "content": "Hello, this is a test message"},
                        {"role": "assistant", "content": "Hi back"},
                    ],
                ),
            )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["messages"]) == 2
        assert data["created_at"] == created["created_at"]
        assert data["updated_at"] >= created["updated_at"]
        # Title preserved (was auto-derived on create, body has no explicit title)
        assert data["title"] == created["title"]

    def test_put_missing_returns_404(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            resp = client.put(
                f"/projects/{project_dir.name}/conversations/missing",
                json=_payload(),
            )
        assert resp.status_code == 404

    def test_patch_renames(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            created = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(),
            ).json()
            resp = client.patch(
                f"/projects/{project_dir.name}/conversations/{created['id']}",
                json={"title": "Renamed"},
            )
        assert resp.status_code == 200
        assert resp.json()["title"] == "Renamed"

    def test_patch_rejects_empty_title(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            created = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(),
            ).json()
            resp = client.patch(
                f"/projects/{project_dir.name}/conversations/{created['id']}",
                json={"title": "   "},
            )
        assert resp.status_code == 422

    def test_delete_removes_file(self, client: TestClient, project_dir: Path) -> None:
        with patch("app.routes.conversations.PROJECTS_DIR", project_dir.parent):
            created = client.post(
                f"/projects/{project_dir.name}/conversations/",
                json=_payload(),
            ).json()
            path = project_dir / "conversations" / f"{created['id']}.json"
            assert path.exists()
            resp = client.delete(f"/projects/{project_dir.name}/conversations/{created['id']}")
        assert resp.status_code == 204
        assert not path.exists()

    def test_conversations_are_project_scoped(self, client: TestClient, tmp_path: Path) -> None:
        proj_a = tmp_path / "a"
        proj_a.mkdir()
        proj_b = tmp_path / "b"
        proj_b.mkdir()
        with patch("app.routes.conversations.PROJECTS_DIR", tmp_path):
            client.post("/projects/a/conversations/", json=_payload())
            list_a = client.get("/projects/a/conversations/").json()
            list_b = client.get("/projects/b/conversations/").json()
        assert len(list_a) == 1
        assert list_b == []


class TestBumpTs:
    """`_bump_ts` guarantees a strictly-monotonic updated_at even when the
    system clock has microsecond resolution that collides with `existing`."""

    def test_returns_now_when_strictly_greater(self) -> None:
        from app.routes.conversations import _bump_ts

        old = "2000-01-01T00:00:00+00:00"
        result = _bump_ts(old)
        assert result > old

    def test_bumps_by_one_microsecond_when_equal(self) -> None:
        from datetime import UTC, datetime

        from app.routes.conversations import _bump_ts

        # Use a future timestamp to guarantee now() <= existing → bump path.
        future = (datetime.now(UTC).replace(year=datetime.now(UTC).year + 1)).isoformat()
        result = _bump_ts(future)
        assert result > future
        # Difference is exactly 1 microsecond.
        delta = datetime.fromisoformat(result) - datetime.fromisoformat(future)
        assert delta.total_seconds() * 1_000_000 == pytest.approx(1.0, abs=0.5)

    def test_bumps_when_existing_in_future(self) -> None:
        from app.routes.conversations import _bump_ts

        future = "2999-01-01T00:00:00+00:00"
        result = _bump_ts(future)
        assert result > future
