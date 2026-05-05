import asyncio
import os
from typing import Literal

import ollama
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.config import OLLAMA_EMBED_MODEL, OLLAMA_GENERATION_MODEL, PROJECTS_DIR
from app.routes import papers as papers_router
from app.routes import projects as projects_router

app = FastAPI(title="Papers Helper API")

_cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
_cors_methods = os.getenv("CORS_METHODS", "GET,POST,PUT,DELETE,OPTIONS").split(",")
_cors_headers = os.getenv("CORS_HEADERS", "Content-Type,Authorization").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=_cors_methods,
    allow_headers=_cors_headers,
)


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


@app.get("/health")
async def health() -> HealthResponse:
    ollama_status: Literal["connected", "unavailable"] = "unavailable"
    model_statuses: list[OllamaModelStatus] = []
    try:
        list_resp = await asyncio.to_thread(ollama.list)
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
