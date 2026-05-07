import asyncio
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
    set_request_ollama_url,
)
from app.routes import chat as chat_router
from app.routes import papers as papers_router
from app.routes import projects as projects_router

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
    return await call_next(request)


class OllamaModelStatus(BaseModel):
    name: str
    available: bool


class HealthResponse(BaseModel):
    status: Literal["ok"]
    ollama: Literal["connected", "unavailable"]
    ollama_models: list[OllamaModelStatus]
    storage: Literal["accessible", "inaccessible"]


app.include_router(projects_router.router)
app.include_router(papers_router.router)
app.include_router(chat_router.router)


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
    model_statuses: list[OllamaModelStatus] = []
    try:
        effective_url = ollama_url.rstrip("/") if ollama_url else OLLAMA_BASE_URL
        client = ollama.Client(host=effective_url)
        list_resp = await asyncio.wait_for(asyncio.to_thread(client.list), timeout=_OLLAMA_TIMEOUT)
        ollama_status = "connected"
        pulled = {m.model for m in list_resp.models if m.model is not None}
        for name in (OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL):
            base = name.split(":")[0]
            available = any(p == name or p.startswith(base + ":") for p in pulled)
            model_statuses.append(OllamaModelStatus(name=name, available=available))
    except Exception:
        pass

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
        storage=storage_status,
    )
