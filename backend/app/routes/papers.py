from __future__ import annotations

import asyncio
import ipaddress
import mimetypes
import socket
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.chroma import get_collection
from app.config import PROJECTS_DIR
from app.ingestion import _stream_upload, _stream_url_import

router = APIRouter(prefix="/projects/{project_id}/papers", tags=["papers"])

# ---------------------------------------------------------------------------
# SSRF protection
# ---------------------------------------------------------------------------

_ALLOWED_SCHEMES = frozenset({"http", "https"})


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
                f"Schéma d'URL non autorisé : {parsed.scheme!r}."
                " Seuls http et https sont acceptés."
            ),
        )

    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(status_code=400, detail="URL invalide : hôte manquant.")

    _BLOCKED_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})
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


class UpdateMetadataRequest(BaseModel):
    pdf_title: str | None = None
    author: str | None = None
    authors_json: str | None = None
    year: str | None = None
    publication: str | None = None
    doi: str | None = None
    abstract: str | None = None
    notes: str | None = None


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/", response_model=list[PaperInfo])
async def list_papers(project_id: str) -> list[PaperInfo]:
    def _fetch() -> list[PaperInfo]:
        collection = get_collection(project_id)
        result = collection.get(include=["metadatas"])
        papers: dict[str, PaperInfo] = {}
        for meta in result["metadatas"] or []:
            stem = str(meta["source_stem"])
            if stem not in papers:
                papers[stem] = PaperInfo(
                    stem=stem,
                    filename=str(meta["source_filename"]),
                    chunk_total=int(meta["chunk_total"]),  # type: ignore[arg-type]
                    pdf_title=str(meta.get("pdf_title", "")),
                    author=str(meta.get("author", "")),
                    year=str(meta.get("year", "")),
                    source_type=str(meta.get("source_type", "document")),
                    authors_json=str(meta.get("authors_json", "")),
                    publication=str(meta.get("publication", "")),
                    doi=str(meta.get("doi", "")),
                    abstract=str(meta.get("abstract", "")),
                    notes=str(meta.get("notes", "")),
                )
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
    _: Path = Depends(_get_files_dir),
) -> FileResponse:
    def _get_filename() -> str | None:
        collection = get_collection(project_id)
        result = collection.get(where={"source_stem": stem}, include=["metadatas"])
        if not result["ids"]:
            return None
        assert result["metadatas"] is not None
        return str(result["metadatas"][0]["source_filename"])

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
) -> PaperInfo:
    _PROTECTED_KEYS = frozenset({
        "source_stem", "source_filename", "chunk_index", "chunk_total", "word_count", "source_type",
    })

    def _update() -> PaperInfo:
        collection = get_collection(project_id)
        result = collection.get(where={"source_stem": stem}, include=["metadatas"])
        if not result["ids"]:
            raise HTTPException(status_code=404, detail="Paper not found")
        assert result["metadatas"] is not None
        raw_patch = body.model_dump(exclude_none=True)
        patch = {k: v for k, v in raw_patch.items() if k not in _PROTECTED_KEYS}
        updated_metas = [{**meta, **patch} for meta in result["metadatas"]]
        collection.update(ids=result["ids"], metadatas=updated_metas)  # type: ignore[arg-type]
        first = updated_metas[0]
        return PaperInfo(
            stem=stem,
            filename=str(first["source_filename"]),
            chunk_total=int(first["chunk_total"]),
            pdf_title=str(first.get("pdf_title", "")),
            author=str(first.get("author", "")),
            year=str(first.get("year", "")),
            source_type=str(first.get("source_type", "document")),
            authors_json=str(first.get("authors_json", "")),
            publication=str(first.get("publication", "")),
            doi=str(first.get("doi", "")),
            abstract=str(first.get("abstract", "")),
            notes=str(first.get("notes", "")),
        )

    return await asyncio.to_thread(_update)


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
    files_dir: Path = Depends(_get_files_dir),
) -> None:
    def _delete() -> str | None:
        collection = get_collection(project_id)
        existing = collection.get(where={"source_stem": stem}, include=["metadatas"])
        if not existing["ids"]:
            return None
        assert existing["metadatas"] is not None
        filename = str(existing["metadatas"][0]["source_filename"])
        collection.delete(ids=existing["ids"])
        return filename

    filename = await asyncio.to_thread(_delete)
    if filename:
        file_path = _resolve_file_path(project_id, filename)
        if file_path:
            file_path.unlink()
