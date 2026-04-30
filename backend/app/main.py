import os
from pathlib import Path
from typing import Literal

import ollama
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

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

DATA_DIR = Path(os.getenv("DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))


class HealthResponse(BaseModel):
    status: Literal["ok"]
    ollama: Literal["connected", "unavailable"]
    storage: Literal["accessible", "inaccessible"]


@app.get("/health")
async def health() -> HealthResponse:
    ollama_status: Literal["connected", "unavailable"] = "unavailable"
    try:
        ollama.list()
        ollama_status = "connected"
    except Exception:
        pass

    storage_status: Literal["accessible", "inaccessible"] = "inaccessible"
    try:
        pdfs = DATA_DIR / "pdfs"
        vectors = DATA_DIR / "vectors"
        if pdfs.exists() and vectors.exists():
            storage_status = "accessible"
    except Exception:
        pass

    return HealthResponse(status="ok", ollama=ollama_status, storage=storage_status)
