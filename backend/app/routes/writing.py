"""HTTP surface for the writing assistant — "Aide à la rédaction".

A project owns a collection of free-form **writing documents** — one named
rich-text zone each — that the user writes and edits over time. They are
progress indicators the user drafts with AI assistance.

IMPORTANT — these documents are AI-assisted and speculative. They must NEVER
feed back into the knowledge graph or be used as a reference by other features.
By design there is no write path from this module into Chroma or the graph:
document JSON is read and written here only, never passed to
`get_collection().add()`.

Storage mirrors conversations: one JSON file per document under
`data/projects/<id>/writing/`.

- `GET    /projects/{id}/writing/`            → list document summaries.
- `POST   /projects/{id}/writing/`            → create an empty document.
- `GET    /projects/{id}/writing/{doc_id}`    → one document.
- `PUT    /projects/{id}/writing/{doc_id}`    → save title + content + citations.
- `PATCH  /projects/{id}/writing/{doc_id}`    → rename.
- `DELETE /projects/{id}/writing/{doc_id}`    → delete.
- `POST   /projects/{id}/writing/{doc_id}/generate`
                                              → SSE stream of RAG-grounded text.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.chroma import get_collection
from app.config import PROJECTS_DIR, WRITING_CONTEXT_CHAR_CAP, WRITING_RAG_K
from app.llm_service import LLMProvider
from app.ollama_service import OllamaGenerationService
from app.routes.chat.context import _format_problematique_context
from app.routes.projects import read_problematique_sync

router = APIRouter(prefix="/projects/{project_id}/writing", tags=["writing"])

# `/papers` is already the sources router — the writing collection lives at
# `/writing` to avoid the prefix clash.
DEFAULT_TITLE = "Nouveau texte"
RENAME_TITLE_MAX_LEN = 120

_WRITING_SYSTEM_PROMPT = (
    "Tu es un assistant de rédaction académique. Tu rédiges, en français, un "
    "passage destiné à être inséré dans un document de recherche en cours. "
    "Contraintes :\n"
    "- Commence DIRECTEMENT par la première phrase du passage. N'écris JAMAIS "
    "de phrase d'amorce ni de commentaire méta — par exemple « Voici une "
    "proposition d'introduction pour votre pré-mémoire : », « Voici… », "
    "« Bien sûr, voici… », « En tant qu'assistant… ». N'ajoute pas non plus de "
    "conclusion méta (« En résumé… », « J'espère que… »). Le passage doit "
    "pouvoir être collé tel quel dans le document.\n"
    "- Appuie-toi sur les extraits du corpus fournis ; n'invente aucune "
    "référence, aucun auteur ni aucune donnée chiffrée absente du corpus.\n"
    "- Réponds en Markdown simple (paragraphes, *italique*, **gras**, listes si "
    "vraiment utile). N'écris pas de titre.\n"
    "- Reste cohérent avec la problématique du projet et le document en cours."
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class CitationRef(BaseModel):
    """Provenance of a citation inserted into a document — a record only,
    never re-indexed."""

    chunk_id: str
    stem: str = ""
    filename: str = ""
    title: str = ""
    author: str = ""
    year: str = ""
    chunk_index: int = 0


class WritingDoc(BaseModel):
    id: str
    title: str
    content_html: str = ""  # tiptap-serialised HTML
    citations: list[CitationRef] = []
    created_at: str
    updated_at: str


class WritingDocSummary(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class CreateDocRequest(BaseModel):
    title: str | None = None


class SaveDocRequest(BaseModel):
    title: str
    content_html: str = ""
    citations: list[CitationRef] = []


class RenameDocRequest(BaseModel):
    title: str


class GenerateRequest(BaseModel):
    instructions: str = ""
    model: str


# ---------------------------------------------------------------------------
# Storage (mirrors routes/conversations.py)
# ---------------------------------------------------------------------------


def _project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def _writing_dir(project_id: str) -> Path:
    return _project_dir(project_id) / "writing"


def _doc_path(project_id: str, doc_id: str) -> Path:
    return _writing_dir(project_id) / f"{doc_id}.json"


def _require_project(project_id: str) -> None:
    if not _project_dir(project_id).exists():
        raise HTTPException(status_code=404, detail="Project not found")


def _bump_ts(existing: str) -> str:
    """Return now() ISO string, guaranteed strictly greater than `existing`."""
    now = datetime.now(UTC).isoformat()
    if now <= existing:
        return (datetime.fromisoformat(existing) + timedelta(microseconds=1)).isoformat()
    return now


def _read_doc(path: Path) -> WritingDoc:
    return WritingDoc(**json.loads(path.read_text(encoding="utf-8")))


def _write_doc(path: Path, doc: WritingDoc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(doc.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_doc_or_404(project_id: str, doc_id: str) -> WritingDoc:
    path = _doc_path(project_id, doc_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document not found")
    return _read_doc(path)


# ---------------------------------------------------------------------------
# RAG generation
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _html_to_text(content_html: str) -> str:
    """Best-effort plain-text extraction from tiptap HTML for context."""
    return _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", content_html))).strip()


def _retrieve_corpus_context(project_id: str, query: str) -> str | None:
    """Semantic search over the project's indexed chunks, formatted as a system
    message. Returns None for an empty query or a project with no indexed
    content (the model then writes from the problématique alone)."""
    if not query.strip():
        return None
    collection = get_collection(project_id)
    count = collection.count()
    if count == 0:
        return None
    qres = collection.query(
        query_texts=[query],
        n_results=min(WRITING_RAG_K, count),
        include=["documents", "metadatas"],
    )
    docs = list((qres.get("documents") or [[]])[0] or [])
    metas = list((qres.get("metadatas") or [[]])[0] or [])

    blocks: list[str] = []
    for doc, meta in zip(docs, metas, strict=False):
        if not doc:
            continue
        meta_d = dict(meta) if meta else {}
        fname = str(meta_d.get("source_filename") or meta_d.get("source_stem") or "?")
        idx = meta_d.get("chunk_index", 0)
        total = meta_d.get("chunk_total")
        loc = f"chunk {idx}/{total}" if total else f"chunk {idx}"
        blocks.append(f"--- {fname} ({loc}) ---\n{doc}")
    if not blocks:
        return None

    header = (
        "Extraits du corpus du projet trouvés par recherche sémantique. "
        "Sers-t'en comme matière première et appui factuel ; ne cite que ce "
        "qui y figure."
    )
    return f"{header}\n\n" + "\n\n".join(blocks)


def _build_messages(project_id: str, doc: WritingDoc, instructions: str) -> list[dict[str, Any]]:
    """Assemble the Ollama message list for a generation. Runs the blocking
    Chroma / problématique reads — call via asyncio.to_thread."""
    problem = read_problematique_sync(project_id)

    # RAG retrieval query: the user's instructions drive the search (same idea
    # as the chat endpoint searching on the user message). Concatenating the
    # whole problématique here would dilute the embedding and pull chunks
    # related to the project at large rather than to what was asked. The
    # problématique still reaches the model as its own system block below.
    # Fall back to the title + research problem only for an unsteered run.
    query = instructions.strip() or " ".join(
        p.strip() for p in (doc.title, problem.research_problem) if p.strip()
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": _WRITING_SYSTEM_PROMPT}]

    problematique_ctx = _format_problematique_context(project_id)
    if problematique_ctx:
        messages.append({"role": "system", "content": problematique_ctx})

    corpus_ctx = _retrieve_corpus_context(project_id, query)
    if corpus_ctx:
        messages.append({"role": "system", "content": corpus_ctx})

    current = _html_to_text(doc.content_html)
    if current:
        capped = current[:WRITING_CONTEXT_CHAR_CAP]
        if len(current) > WRITING_CONTEXT_CHAR_CAP:
            capped += " […]"
        messages.append(
            {
                "role": "system",
                "content": f"Document en cours de rédaction (pour cohérence) :\n\n{capped}",
            }
        )

    user = "Rédige un passage à insérer dans le document."
    if instructions.strip():
        user += f"\nConsignes : {instructions.strip()}"
    # Repeated at the tail — small local models weight the end of the prompt
    # most, so the no-preamble rule is reaffirmed here, last.
    user += (
        "\n\nCommence directement par le texte du passage, sans aucune phrase "
        "d'introduction du type « Voici une proposition… »."
    )
    messages.append({"role": "user", "content": user})
    return messages


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/", response_model=list[WritingDocSummary])
async def list_documents(project_id: str) -> list[WritingDocSummary]:
    _require_project(project_id)

    def _scan() -> list[WritingDocSummary]:
        wdir = _writing_dir(project_id)
        if not wdir.exists():
            return []
        out: list[WritingDocSummary] = []
        for entry in wdir.iterdir():
            if not entry.is_file() or entry.suffix != ".json":
                continue
            try:
                doc = _read_doc(entry)
            except (json.JSONDecodeError, ValueError):
                continue
            out.append(
                WritingDocSummary(
                    id=doc.id,
                    title=doc.title,
                    created_at=doc.created_at,
                    updated_at=doc.updated_at,
                )
            )
        return sorted(out, key=lambda d: d.updated_at, reverse=True)

    return await asyncio.to_thread(_scan)


@router.post("/", response_model=WritingDoc, status_code=201)
async def create_document(project_id: str, body: CreateDocRequest) -> WritingDoc:
    _require_project(project_id)
    now = datetime.now(UTC).isoformat()
    title = (body.title or "").strip() or DEFAULT_TITLE
    doc = WritingDoc(id=str(uuid.uuid4()), title=title, created_at=now, updated_at=now)

    def _write() -> WritingDoc:
        _write_doc(_doc_path(project_id, doc.id), doc)
        return doc

    return await asyncio.to_thread(_write)


@router.get("/{doc_id}", response_model=WritingDoc)
async def get_document(project_id: str, doc_id: str) -> WritingDoc:
    _require_project(project_id)
    return await asyncio.to_thread(_load_doc_or_404, project_id, doc_id)


@router.put("/{doc_id}", response_model=WritingDoc)
async def save_document(project_id: str, doc_id: str, body: SaveDocRequest) -> WritingDoc:
    _require_project(project_id)

    def _write() -> WritingDoc:
        existing = _load_doc_or_404(project_id, doc_id)
        updated = WritingDoc(
            id=existing.id,
            title=body.title.strip() or existing.title,
            content_html=body.content_html,
            citations=body.citations,
            created_at=existing.created_at,
            updated_at=_bump_ts(existing.updated_at),
        )
        _write_doc(_doc_path(project_id, doc_id), updated)
        return updated

    return await asyncio.to_thread(_write)


@router.patch("/{doc_id}", response_model=WritingDoc)
async def rename_document(project_id: str, doc_id: str, body: RenameDocRequest) -> WritingDoc:
    _require_project(project_id)
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Title cannot be empty")
    if len(title) > RENAME_TITLE_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"Title must be {RENAME_TITLE_MAX_LEN} characters or fewer",
        )

    def _write() -> WritingDoc:
        existing = _load_doc_or_404(project_id, doc_id)
        updated = existing.model_copy(
            update={"title": title, "updated_at": _bump_ts(existing.updated_at)}
        )
        _write_doc(_doc_path(project_id, doc_id), updated)
        return updated

    return await asyncio.to_thread(_write)


@router.delete("/{doc_id}", status_code=204)
async def delete_document(project_id: str, doc_id: str) -> None:
    _require_project(project_id)
    path = _doc_path(project_id, doc_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Document not found")
    await asyncio.to_thread(path.unlink)


@router.post("/{doc_id}/generate")
async def generate_passage(
    project_id: str,
    doc_id: str,
    req: GenerateRequest,
    x_llm_provider: str | None = Header(default=None),
) -> StreamingResponse:
    """Stream RAG-grounded text for a document as SSE. The endpoint never
    persists — the client inserts the accepted text and saves via PUT."""
    _require_project(project_id)
    if not req.model.strip():
        raise HTTPException(status_code=400, detail="model vide")
    # v1 is Ollama-only — generation runs against the local model.
    if x_llm_provider and x_llm_provider != LLMProvider.OLLAMA.value:
        raise HTTPException(
            status_code=400,
            detail="La génération ne supporte que le fournisseur Ollama.",
        )

    doc = await asyncio.to_thread(_load_doc_or_404, project_id, doc_id)
    messages = await asyncio.to_thread(_build_messages, project_id, doc, req.instructions)
    service = OllamaGenerationService(model=req.model)

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            async for token in service.stream_generate_messages(messages):
                yield f"data: {json.dumps({'token': token})}\n\n"
        except Exception as exc:  # noqa: BLE001 — surface every provider failure
            message = str(exc) or exc.__class__.__name__
            yield f"data: {json.dumps({'error': message})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


__all__ = ["CitationRef", "WritingDoc", "WritingDocSummary", "router"]
