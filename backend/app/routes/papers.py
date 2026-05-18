from __future__ import annotations

import asyncio
import ipaddress
import logging
import mimetypes
import socket
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.chroma import get_collection
from app.config import PROJECTS_DIR
from app.graph import graph_remove_source, graph_update_source
from app.graph.concepts import CONCEPT_INPUT_FIELDS
from app.ingestion import (
    EDITABLE_META_KEYS,
    SidecarMeta,
    _stream_index_pending,
    _stream_reindex,
    _stream_single_reindex,
    _stream_upload,
    _stream_url_import,
    iter_source_files,
    prune_orphan_sidecars,
    read_sidecar,
    sidecar_path,
    strip_title_braces,
    write_sidecar,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/papers", tags=["papers"])

# ---------------------------------------------------------------------------
# SSRF protection
# ---------------------------------------------------------------------------

_ALLOWED_SCHEMES = frozenset({"http", "https"})
_BLOCKED_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})


def _validate_url_ssrf(url: str) -> None:
    """Raise HTTPException 400 if *url* targets a private/loopback/link-local address.

    Protects against Server-Side Request Forgery: an attacker could otherwise
    supply URLs like http://127.0.0.1:8080/internal or http://169.254.169.254/
    to reach services that are only accessible from the backend host.
    """
    parsed = urlparse(url)
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Schéma d'URL non autorisé : {parsed.scheme!r}. Seuls http et https sont acceptés."
            ),
        )

    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="URL invalide : hôte manquant.")

    if hostname.lower() in _BLOCKED_HOSTNAMES:
        raise HTTPException(status_code=400, detail="URL non autorisée : hôte privé ou local.")

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail=f"Impossible de résoudre l'hôte : {hostname}")

    for _family, _type, _proto, _canonname, sockaddr in infos:
        raw_ip = sockaddr[0]
        try:
            addr = ipaddress.ip_address(raw_ip)
        except ValueError:
            continue
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            raise HTTPException(
                status_code=400,
                detail=f"URL non autorisée : l'adresse {raw_ip} est privée ou réservée.",
            )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class PaperInfo(BaseModel):
    stem: str
    filename: str
    chunk_total: int
    pdf_title: str
    author: str
    year: str
    source_type: str = "document"
    authors_json: str = ""
    publication: str = ""
    doi: str = ""
    abstract: str = ""
    notes: str = ""
    categories: str = ""
    indexed: bool = False
    index_error: str = ""


class UpdateMetadataRequest(BaseModel):
    pdf_title: str | None = None
    author: str | None = None
    authors_json: str | None = None
    year: str | None = None
    publication: str | None = None
    doi: str | None = None
    abstract: str | None = None
    notes: str | None = None
    categories: str | None = None


class AddUrlRequest(BaseModel):
    url: str


class ChunkInfo(BaseModel):
    id: str
    chunk_index: int
    word_count: int
    text: str


# ---------------------------------------------------------------------------
# Dependencies / file-system helpers
# ---------------------------------------------------------------------------


def _get_files_dir(project_id: str) -> Path:
    project_dir = PROJECTS_DIR / project_id
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    # Support legacy "pdfs/" directory; new uploads go to "files/"
    files_dir = project_dir / "files"
    files_dir.mkdir(exist_ok=True)
    return files_dir


def _resolve_file_path(project_id: str, filename: str) -> Path | None:
    """Locate a stored file, checking both 'files/' and legacy 'pdfs/'."""
    project_dir = PROJECTS_DIR / project_id
    for subdir in ("files", "pdfs"):
        candidate = project_dir / subdir / filename
        if candidate.exists():
            return candidate
    return None


def _paper_from_meta(meta: SidecarMeta, chunk_total: int) -> PaperInfo:
    return PaperInfo(
        stem=meta.stem,
        filename=meta.filename,
        chunk_total=chunk_total,
        pdf_title=meta.pdf_title,
        author=meta.author,
        year=meta.year,
        source_type=meta.source_type,
        authors_json=meta.authors_json,
        publication=meta.publication,
        doi=meta.doi,
        abstract=meta.abstract,
        notes=meta.notes,
        categories=meta.categories,
        indexed=chunk_total > 0,
        index_error=meta.index_error,
    )


async def _safe_graph_update(project_id: str, stem: str) -> None:
    """BackgroundTasks-friendly wrapper: never raises, always logs.

    Concept extraction can stall for seconds on the LLM round-trip; we defer
    it so PATCH/DELETE responses don't block the user on graph work.
    """
    try:
        await graph_update_source(project_id, stem)
    except Exception as exc:  # noqa: BLE001
        log.warning("graph_update_source (bg) failed for %s/%s: %s", project_id, stem, exc)


async def _safe_graph_remove(project_id: str, stem: str) -> None:
    try:
        await graph_remove_source(project_id, stem)
    except Exception as exc:  # noqa: BLE001
        log.warning("graph_remove_source (bg) failed for %s/%s: %s", project_id, stem, exc)


def _strip_title_braces_in_place(
    project_id: str,
    files_dir: Path,
    sidecar: SidecarMeta,
    chroma_meta: dict[str, Any] | None,
) -> None:
    """Drop `{` and `}` characters from legacy Zotero-imported titles while
    keeping the inner words. Persists the sidecar and best-effort mirrors the
    cleaned title into Chroma so chunk-level metadata stays consistent. No-op
    when the title has no braces.
    """
    if not strip_title_braces(sidecar):
        return
    write_sidecar(files_dir, sidecar)
    if chroma_meta is None:
        return
    try:
        col = get_collection(project_id)
        res = col.get(where={"source_stem": sidecar.stem}, include=["metadatas"])
        if res["ids"] and res["metadatas"]:
            patch = {"pdf_title": sidecar.pdf_title}
            updated = [{**m, **patch} for m in (res["metadatas"] or [])]
            col.update(ids=res["ids"], metadatas=updated)  # type: ignore[arg-type]
    except Exception:
        # Chroma may be unreachable (no embed provider); the sidecar write
        # already cleaned the user-visible state.
        log.debug(
            "title-brace migration: Chroma mirror failed for stem %s",
            sidecar.stem,
            exc_info=True,
        )


def _paper_from_chroma_meta(meta: dict[str, Any]) -> PaperInfo:
    """Fallback when a Chroma entry exists with no sidecar — keeps legacy
    projects working without re-indexing them.
    """
    chunk_total = int(meta.get("chunk_total", 0) or 0)
    return PaperInfo(
        stem=str(meta.get("source_stem", "")),
        filename=str(meta.get("source_filename", "")),
        chunk_total=chunk_total,
        pdf_title=str(meta.get("pdf_title", "")),
        author=str(meta.get("author", "")),
        year=str(meta.get("year", "")),
        source_type=str(meta.get("source_type", "document")),
        authors_json=str(meta.get("authors_json", "")),
        publication=str(meta.get("publication", "")),
        doi=str(meta.get("doi", "")),
        abstract=str(meta.get("abstract", "")),
        notes=str(meta.get("notes", "")),
        categories=str(meta.get("categories", "")),
        indexed=chunk_total > 0,
        index_error="",
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/", response_model=list[PaperInfo])
async def list_papers(project_id: str) -> list[PaperInfo]:
    project_dir = PROJECTS_DIR / project_id
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    def _fetch() -> list[PaperInfo]:
        files = iter_source_files(project_dir)

        # Pull chunk_total per stem from Chroma if reachable. If the embedding
        # client can't be built (Ollama unreachable + no API key), fall back to
        # listing sources without their chunk counts rather than 500ing.
        chunk_totals: dict[str, int] = {}
        chroma_metas: dict[str, dict[str, Any]] = {}
        try:
            collection = get_collection(project_id)
            result = collection.get(include=["metadatas"])
            for meta in result["metadatas"] or []:
                stem_val = meta.get("source_stem")
                if not stem_val:
                    continue
                stem = str(stem_val)
                chunk_totals[stem] = int(meta.get("chunk_total", 0) or 0)  # type: ignore[arg-type]
                chroma_metas.setdefault(stem, dict(meta))
        except Exception:
            pass

        papers: dict[str, PaperInfo] = {}

        # Files on disk are the primary source of truth (one entry per file).
        for f in files:
            stem = Path(f.name).stem
            files_dir = f.parent
            sidecar = read_sidecar(files_dir, stem)
            chunk_total = chunk_totals.get(stem, 0)
            if sidecar is not None:
                # Legacy cleanup: strip stray `{` `}` characters from titles
                # imported with Zotero brace decorations. Idempotent — fires at
                # most once per source.
                _strip_title_braces_in_place(project_id, files_dir, sidecar, chroma_metas.get(stem))
                papers[stem] = _paper_from_meta(sidecar, chunk_total)
            elif stem in chroma_metas:
                # Legacy project: no sidecar but chunks exist in Chroma.
                papers[stem] = _paper_from_chroma_meta(chroma_metas[stem])
            else:
                # File present without metadata anywhere: surface it as
                # non-indexed so the user can re-trigger ingestion.
                papers[stem] = PaperInfo(
                    stem=stem,
                    filename=f.name,
                    chunk_total=0,
                    pdf_title="",
                    author="",
                    year="",
                    indexed=False,
                    index_error="",
                )

        # Self-heal: drop sidecars whose document is gone. Catches orphans
        # left by a delete that raced a concurrent metadata write (e.g.
        # background auto-enrichment patching a just-deleted source).
        pruned = prune_orphan_sidecars(project_dir, set(papers.keys()))
        if pruned:
            log.info("pruned %d orphan sidecar(s) in %s: %s", len(pruned), project_id, pruned)

        return list(papers.values())

    return await asyncio.to_thread(_fetch)


@router.get("/{stem}/chunks", response_model=list[ChunkInfo])
async def get_paper_chunks(project_id: str, stem: str) -> list[ChunkInfo]:
    def _fetch() -> list[ChunkInfo]:
        collection = get_collection(project_id)
        result = collection.get(
            where={"source_stem": stem},
            include=["documents", "metadatas"],
        )
        chunks = []
        for id_, doc, meta in zip(
            result["ids"], result["documents"] or [], result["metadatas"] or []
        ):
            chunks.append(
                ChunkInfo(
                    id=id_,
                    chunk_index=int(meta["chunk_index"]),  # type: ignore[arg-type]
                    word_count=int(meta["word_count"]),  # type: ignore[arg-type]
                    text=doc,
                )
            )
        return sorted(chunks, key=lambda c: c.chunk_index)

    return await asyncio.to_thread(_fetch)


@router.get("/{stem}/file")
async def get_paper_file(
    project_id: str,
    stem: str,
    files_dir: Path = Depends(_get_files_dir),
) -> FileResponse:
    def _get_filename() -> str | None:
        # Prefer sidecar (works without Ollama).
        sidecar = read_sidecar(files_dir, stem)
        if sidecar is not None:
            return sidecar.filename
        try:
            collection = get_collection(project_id)
            result = collection.get(where={"source_stem": stem}, include=["metadatas"])
            if result["ids"] and result["metadatas"]:
                return str(result["metadatas"][0]["source_filename"])
        except Exception:
            pass
        return None

    filename = await asyncio.to_thread(_get_filename)
    if not filename:
        raise HTTPException(status_code=404, detail="Paper not found")

    file_path = _resolve_file_path(project_id, filename)
    if not file_path:
        raise HTTPException(status_code=404, detail="File not found on disk")

    media_type, _enc = mimetypes.guess_type(file_path.name)
    return FileResponse(str(file_path), media_type=media_type or "application/octet-stream")


@router.post("/upload/stream")
async def upload_papers_stream(
    project_id: str,
    files: list[UploadFile] = File(...),
    files_dir: Path = Depends(_get_files_dir),
) -> StreamingResponse:
    return StreamingResponse(
        _stream_upload(project_id, files, files_dir),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.patch("/{stem}", response_model=PaperInfo)
async def update_paper_metadata(
    project_id: str,
    stem: str,
    body: UpdateMetadataRequest,
    background_tasks: BackgroundTasks,
    files_dir: Path = Depends(_get_files_dir),
) -> PaperInfo:
    def _update() -> PaperInfo:
        sidecar = read_sidecar(files_dir, stem)

        # Try to update Chroma in parallel, but tolerate Ollama being down: the
        # sidecar is the source of truth used by list_papers.
        chroma_meta: dict[str, Any] | None = None
        chunk_total = 0
        try:
            collection = get_collection(project_id)
            result = collection.get(where={"source_stem": stem}, include=["metadatas"])
            if result["ids"] and result["metadatas"]:
                chroma_meta = dict(result["metadatas"][0])
                chunk_total = int(chroma_meta.get("chunk_total", 0) or 0)
        except Exception:
            collection = None
            result = None

        if sidecar is None and chroma_meta is None:
            raise HTTPException(status_code=404, detail="Paper not found")

        # Reconstruct sidecar from Chroma if missing (legacy projects).
        if sidecar is None:
            assert chroma_meta is not None
            sidecar = SidecarMeta(
                stem=stem,
                filename=str(chroma_meta.get("source_filename", "")),
                source_type=str(chroma_meta.get("source_type", "document")),
                pdf_title=str(chroma_meta.get("pdf_title", "")),
                author=str(chroma_meta.get("author", "")),
                year=str(chroma_meta.get("year", "")),
                authors_json=str(chroma_meta.get("authors_json", "")),
                publication=str(chroma_meta.get("publication", "")),
                doi=str(chroma_meta.get("doi", "")),
                abstract=str(chroma_meta.get("abstract", "")),
                notes=str(chroma_meta.get("notes", "")),
                categories=str(chroma_meta.get("categories", "")),
            )

        patch = body.model_dump(exclude_none=True)
        patch = {k: v for k, v in patch.items() if k in EDITABLE_META_KEYS}
        # Invalidate cached concepts when their inputs change: extract_concepts
        # reads `pdf_title` + `abstract`, so a real edit to either must trigger
        # a fresh extraction on the next graph_update_source call.
        concepts_inputs_changed = any(
            field in patch and patch[field] != getattr(sidecar, field)
            for field in CONCEPT_INPUT_FIELDS
        )
        for k, v in patch.items():
            setattr(sidecar, k, v)
        if concepts_inputs_changed:
            sidecar.concepts_json = ""

        # Legacy Zotero compat: strip stray `{` `}` characters from the title
        # on save. Keeps the inner words intact — only the brace decorations go.
        if strip_title_braces(sidecar):
            patch["pdf_title"] = sidecar.pdf_title

        # Guard against a delete/enrich race: if the backing document was
        # removed while this update was being prepared (e.g. background
        # auto-enrichment generating an abstract for a source the user just
        # deleted), refuse the write instead of resurrecting an orphan
        # sidecar. Re-checked here, as late as possible, to keep the window
        # between the check and `write_sidecar` negligible.
        if _resolve_file_path(project_id, sidecar.filename) is None:
            raise HTTPException(status_code=404, detail="Paper not found")

        write_sidecar(files_dir, sidecar)

        # Mirror the patch into Chroma if the collection has this source.
        if collection is not None and result is not None and result["ids"] and result["metadatas"]:
            updated = [{**meta, **patch} for meta in result["metadatas"]]
            collection.update(ids=result["ids"], metadatas=updated)  # type: ignore[arg-type]
            chunk_total = int(updated[0].get("chunk_total", 0) or 0)

        return _paper_from_meta(sidecar, chunk_total)

    paper = await asyncio.to_thread(_update)
    # Sync the graph with the patched metadata off the request path. Concept
    # extraction is an LLM round-trip; running it inline would make the user
    # wait seconds for a PATCH that already finished on disk. Best-effort:
    # `_safe_graph_update` never raises.
    background_tasks.add_task(_safe_graph_update, project_id, stem)
    return paper


@router.post("/index/stream")
async def index_pending_papers(
    project_id: str,
    files_dir: Path = Depends(_get_files_dir),
) -> StreamingResponse:
    """Stage 2 of ingestion: embed every source file not yet in Chroma.

    Auto-chained by the frontend right after an upload (which only saves +
    parses files). Idempotent — already-indexed sources are skipped.
    """
    return StreamingResponse(
        _stream_index_pending(project_id, files_dir),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/reindex")
async def reindex_papers(
    project_id: str,
    files_dir: Path = Depends(_get_files_dir),
) -> StreamingResponse:
    return StreamingResponse(
        _stream_reindex(project_id, files_dir),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{stem}/reindex")
async def reindex_one_paper(
    project_id: str,
    stem: str,
    files_dir: Path = Depends(_get_files_dir),
) -> StreamingResponse:
    sidecar = read_sidecar(files_dir, stem)
    filename: str | None = None
    if sidecar is not None:
        filename = sidecar.filename
    if filename is None:
        # Last-resort lookup: scan files on disk for a matching stem.
        for f in iter_source_files(PROJECTS_DIR / project_id):
            if Path(f.name).stem == stem:
                filename = f.name
                break
    if filename is None:
        raise HTTPException(status_code=404, detail="Paper not found")

    file_path = _resolve_file_path(project_id, filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="File not found on disk")

    return StreamingResponse(
        _stream_single_reindex(project_id, files_dir, stem, file_path),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/url")
async def add_url_source(
    project_id: str,
    body: AddUrlRequest,
    files_dir: Path = Depends(_get_files_dir),
) -> StreamingResponse:
    _validate_url_ssrf(body.url)
    return StreamingResponse(
        _stream_url_import(project_id, body.url, files_dir),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/{stem}", status_code=204)
async def delete_paper(
    project_id: str,
    stem: str,
    background_tasks: BackgroundTasks,
    files_dir: Path = Depends(_get_files_dir),
) -> None:
    def _delete() -> tuple[str | None, bool]:
        sidecar = read_sidecar(files_dir, stem)
        filename: str | None = sidecar.filename if sidecar else None
        found = sidecar is not None

        # Try to drop chunks from Chroma; missing collection is fine for sources
        # that were never indexed (Ollama unreachable at import time).
        try:
            collection = get_collection(project_id)
            existing = collection.get(where={"source_stem": stem}, include=["metadatas"])
            if existing["ids"]:
                found = True
                if filename is None and existing["metadatas"]:
                    filename = str(existing["metadatas"][0]["source_filename"])
                collection.delete(ids=existing["ids"])
        except Exception:
            pass

        sidecar_path(files_dir, stem).unlink(missing_ok=True)
        return filename, found

    filename, found = await asyncio.to_thread(_delete)
    if not found:
        raise HTTPException(status_code=404, detail="Paper not found")
    if filename:
        file_path = _resolve_file_path(project_id, filename)
        if file_path:
            file_path.unlink(missing_ok=True)
    # Drop the paper from the knowledge graph off the request path so the
    # 204 lands instantly. Best-effort: `_safe_graph_remove` never raises.
    background_tasks.add_task(_safe_graph_remove, project_id, stem)
