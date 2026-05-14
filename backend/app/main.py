import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Literal

import ollama
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.config import (
    OLLAMA_BASE_URL,
    OLLAMA_EMBED_MODEL,
    OLLAMA_GENERATION_MODEL,
    PROJECTS_DIR,
    set_request_embed_config,
    set_request_ollama_url,
)
from app.embeddings import resolve_embed_config
from app.routes import chat as chat_router
from app.routes import conversations as conversations_router
from app.routes import graph as graph_router
from app.routes import papers as papers_router
from app.routes import projects as projects_router
from app.routes.chat import condense_routes as condense_router

log = logging.getLogger("papers-helper.health")

app = FastAPI(title="Papers Helper API")

_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
_cors_methods = os.getenv("CORS_METHODS", "GET,POST,PUT,DELETE,OPTIONS").split(",")
_cors_headers = os.getenv(
    "CORS_HEADERS", "Content-Type,Authorization,X-Ollama-URL,X-LLM-Provider,X-LLM-API-Key"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=_cors_methods,
    allow_headers=_cors_headers,
)


@app.middleware("http")
async def ollama_url_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    custom_url = request.headers.get("X-Ollama-URL")
    set_request_ollama_url(custom_url.rstrip("/") if custom_url else OLLAMA_BASE_URL)
    set_request_embed_config(
        resolve_embed_config(
            request.headers.get("X-LLM-Provider"),
            request.headers.get("X-LLM-API-Key"),
        )
    )
    return await call_next(request)


class OllamaModelStatus(BaseModel):
    name: str
    available: bool


class HealthResponse(BaseModel):
    status: Literal["ok"]
    ollama: Literal["connected", "unavailable"]
    ollama_models: list[OllamaModelStatus]
    ollama_url: str
    ollama_error: str | None = None
    storage: Literal["accessible", "inaccessible"]


app.include_router(projects_router.router)
app.include_router(papers_router.router)
app.include_router(chat_router.router)
app.include_router(condense_router.router)
app.include_router(conversations_router.router)
app.include_router(graph_router.router)


_OLLAMA_TIMEOUT = 5.0


@app.get("/models")
async def list_models(request: Request) -> list[str]:
    url = request.headers.get("X-Ollama-URL", OLLAMA_BASE_URL)
    client = ollama.Client(host=url)
    resp = await asyncio.wait_for(asyncio.to_thread(client.list), timeout=_OLLAMA_TIMEOUT)
    return [m.model for m in resp.models if m.model]


@app.get("/health")
async def health(ollama_url: str | None = Query(default=None)) -> HealthResponse:
    ollama_status: Literal["connected", "unavailable"] = "unavailable"
    pulled: set[str] = set()
    effective_url = ollama_url.rstrip("/") if ollama_url else OLLAMA_BASE_URL
    ollama_error: str | None = None
    try:
        client = ollama.Client(host=effective_url)
        list_resp = await asyncio.wait_for(asyncio.to_thread(client.list), timeout=_OLLAMA_TIMEOUT)
        ollama_status = "connected"
        pulled = {m.model for m in list_resp.models if m.model is not None}
    except Exception as exc:
        ollama_error = f"{type(exc).__name__}: {exc}"
        log.warning("Ollama health check failed at %s: %s", effective_url, ollama_error)

    # Always advertise the required model names so the frontend can guide the
    # user through `ollama pull` even when Ollama itself is unreachable.
    model_statuses: list[OllamaModelStatus] = []
    for name in (OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL):
        base = name.split(":")[0]
        available = any(p == name or p.startswith(base + ":") for p in pulled)
        model_statuses.append(OllamaModelStatus(name=name, available=available))

    storage_status: Literal["accessible", "inaccessible"] = "inaccessible"
    try:
        if PROJECTS_DIR.parent.exists():
            storage_status = "accessible"
    except Exception:
        pass

    return HealthResponse(
        status="ok",
        ollama=ollama_status,
        ollama_models=model_statuses,
        ollama_url=effective_url,
        ollama_error=ollama_error,
        storage=storage_status,
    )
