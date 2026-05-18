"""FastAPI endpoint for /categorize — one-shot LLM categorisation.

Used by the enrichment pass to derive category labels from an already-generated
abstract: a single LLM call, no Chroma read, no map-reduce fan-out. Stays thin
— provider/header parsing then a call into `condense.run_single_generation`.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.llm_service import LLMProvider
from app.routes.chat.condense import run_single_generation

router = APIRouter(prefix="/projects/{project_id}", tags=["categorize"])


class CategorizeRequest(BaseModel):
    prompt: str
    text: str
    model: str


class CategorizeResponse(BaseModel):
    text: str


@router.post("/categorize", response_model=CategorizeResponse)
async def categorize(
    project_id: str,
    req: CategorizeRequest,
    x_llm_provider: str | None = Header(default=None),
    x_llm_api_key: str | None = Header(default=None),
) -> CategorizeResponse:
    _ = project_id  # path param — kept for routing, unused in the handler
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt vide")
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text vide")
    if not req.model.strip():
        raise HTTPException(status_code=400, detail="model vide")

    provider = LLMProvider.OLLAMA
    if x_llm_provider:
        try:
            provider = LLMProvider(x_llm_provider)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Unknown LLM provider: {x_llm_provider}")
    if provider != LLMProvider.OLLAMA and not x_llm_api_key:
        raise HTTPException(
            status_code=400,
            detail="X-LLM-API-Key header required for external providers",
        )

    content = f"{req.prompt}\n\n--- RÉSUMÉ ---\n{req.text}"
    try:
        # ollama_base_url=None → OllamaGenerationService picks up the per-request
        # URL set by the X-Ollama-URL middleware (same path as /condense).
        out = await run_single_generation(
            provider=provider,
            model=req.model,
            api_key=x_llm_api_key,
            ollama_base_url=None,
            content=content,
        )
    except Exception as exc:  # noqa: BLE001 — surface every provider failure
        raise HTTPException(status_code=502, detail=str(exc) or exc.__class__.__name__)
    return CategorizeResponse(text=out)


__all__ = ["CategorizeRequest", "CategorizeResponse", "categorize", "router"]
