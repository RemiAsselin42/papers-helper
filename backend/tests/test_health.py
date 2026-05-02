"""Tests for the /health endpoint."""

from collections.abc import Generator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c


def test_health_ollama_unavailable(client: TestClient) -> None:
    """Returns storage status even when Ollama is unreachable."""
    with patch("app.main.ollama.list", side_effect=Exception("connection refused")):
        response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["ollama"] == "unavailable"
    assert "storage" in body


def test_health_ollama_connected(client: TestClient) -> None:
    """Reports connected when Ollama responds."""
    with patch("app.main.ollama.list", return_value=MagicMock()):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["ollama"] == "connected"


def test_health_storage_inaccessible_when_dirs_missing(client: TestClient) -> None:
    """Reports inaccessible when data directories do not exist."""
    with (
        patch("app.main.ollama.list", side_effect=Exception("offline")),
        patch.object(Path, "exists", return_value=False),
    ):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["storage"] == "inaccessible"


def test_health_storage_accessible_when_dirs_present(client: TestClient, tmp_path: Path) -> None:
    """Reports accessible when the projects directory parent exists."""
    with (
        patch("app.main.PROJECTS_DIR", tmp_path / "projects"),
        patch("app.main.ollama.list", return_value=MagicMock()),
    ):
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["storage"] == "accessible"
