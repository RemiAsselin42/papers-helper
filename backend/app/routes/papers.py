from __future__ import annotations

import asyncio
import io
import ipaddress
import json
import mimetypes
import re
import socket
import time
import zipfile
from collections.abc import AsyncGenerator
from pathlib import Path
from urllib.parse import urlparse

import chromadb
import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.chroma import get_collection
from app.config import PROJECTS_DIR
from app.parsers import (
    MANIFEST_EXTENSIONS,
    MAX_FILE_SIZE,
    SUPPORTED_EXTENSIONS,
    BibtexEntry,
    ParseResult,
    parse,
    parse_bibtex,
)
from app.parsers._bibtex import normalize_title

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

    # Reject obvious loopback/private hostnames before DNS resolution
    _BLOCKED_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})
    if hostname.lower() in _BLOCKED_HOSTNAMES:
        raise HTTPException(status_code=400, detail="URL non autorisée : hôte privé ou local.")

    # Resolve DNS and check each returned address
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


def _sse(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


def normalize_text(text: str) -> str:
    text = re.sub(r"-\n", "", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text: str, target_words: int = 500) -> list[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    bucket: list[str] = []
    bucket_words = 0

    for para in paragraphs:
        para_words = len(para.split())
        if bucket_words + para_words > target_words and bucket:
            chunks.append("\n\n".join(bucket))
            bucket = []
            bucket_words = 0
        bucket.append(para)
        bucket_words += para_words

    if bucket:
        chunks.append("\n\n".join(bucket))

    return chunks


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


def _index_chunks(
    collection: chromadb.Collection,
    stem: str,
    filename: str,
    chunks: list[str],
    pdf_title: str = "",
    author: str = "",
    year: str = "",
    source_type: str = "document",
    authors_json: str = "",
    publication: str = "",
    doi: str = "",
    abstract: str = "",
) -> int:
    existing = collection.get(where={"source_stem": stem})
    if existing["ids"]:
        collection.delete(ids=existing["ids"])
    chunk_total = len(chunks)
    collection.add(
        documents=chunks,
        ids=[f"{stem}__chunk_{i:04d}" for i in range(chunk_total)],
        metadatas=[
            {
                "source_filename": filename,
                "source_stem": stem,
                "chunk_index": i,
                "chunk_total": chunk_total,
                "word_count": len(chunk.split()),
                "pdf_title": pdf_title,
                "author": author,
                "year": year,
                "source_type": source_type,
                "authors_json": authors_json,
                "publication": publication,
                "doi": doi,
                "abstract": abstract,
            }
            for i, chunk in enumerate(chunks)
        ],
    )
    return chunk_total


def _url_to_stem(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.replace(".", "_")
    path = parsed.path.strip("/").replace("/", "__")
    raw = f"{host}__{path}" if path else host
    return re.sub(r"[^a-zA-Z0-9_-]", "_", raw)[:80]


def _expand_zip(content: bytes) -> list[tuple[str, bytes]]:
    """Extract BibTeX and document files from a ZIP, returning (basename, bytes) pairs.

    Files in subdirectories are flattened to their basename. Duplicate basenames
    (same name in different subdirs) keep the first occurrence.
    """
    valid_exts = SUPPORTED_EXTENSIONS | MANIFEST_EXTENSIONS
    results: list[tuple[str, bytes]] = []
    seen: set[str] = set()

    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            basename = Path(info.filename).name
            if not basename or basename.startswith("."):
                continue
            ext = Path(basename).suffix.lower()
            if ext not in valid_exts:
                continue
            key = basename.lower()
            if key in seen:
                continue
            seen.add(key)
            with zf.open(info) as f:
                results.append((basename, f.read()))

    return results


MAX_TOTAL_UPLOAD_SIZE = 200 * 1024 * 1024  # 200 MB across all files in one request


class _IndexResult:
    """Return value of _parse_and_index_file."""

    __slots__ = ("chunk_total",)

    def __init__(self, chunk_total: int) -> None:
        self.chunk_total = chunk_total


async def _parse_and_index_file(
    project_id: str,
    filename: str,
    content: bytes,
    file_path: Path,
    already_existed: bool,
    *,
    bib: BibtexEntry | None = None,
    # Optional fallback used when the parser returns an empty title (e.g. URL import)
    pdf_title_fallback: str = "",
) -> tuple[_IndexResult, None] | tuple[None, str]:
    """Parse *content*, chunk it, and index it into ChromaDB.

    Returns ``(_IndexResult, None)`` on success or ``(None, error_message)`` on
    failure.  On failure the file is rolled back (deleted) unless it pre-existed.
    """
    try:
        result: ParseResult = parse(filename, content)
        text = normalize_text(result.text)
    except Exception as exc:
        if not already_existed:
            file_path.unlink(missing_ok=True)
        return None, f"Erreur d'extraction : {exc}"

    if not text:
        if not already_existed:
            file_path.unlink(missing_ok=True)
        return None, "Aucun texte extrait du fichier"

    chunks = chunk_text(text)
    stem = Path(filename).stem

    pdf_title = (bib.title if bib else result.title) or pdf_title_fallback
    author = bib.author if bib else result.author
    year = bib.year if bib else result.year
    source_type = result.source_type
    authors_json = bib.authors_json if bib else ""
    publication = bib.publication if bib else ""
    doi = bib.doi if bib else ""
    abstract = bib.abstract if bib else ""

    try:
        def _do_index(
            pid: str = project_id,
            s: str = stem,
            f: str = filename,
            c: list[str] = chunks,
            pt: str = pdf_title,
            a: str = author,
            y: str = year,
            st: str = source_type,
            aj: str = authors_json,
            pub: str = publication,
            d: str = doi,
            abstr: str = abstract,
        ) -> int:
            return _index_chunks(
                get_collection(pid), s, f, c,
                pdf_title=pt, author=a, year=y, source_type=st,
                authors_json=aj, publication=pub, doi=d, abstract=abstr,
            )

        chunk_total = await asyncio.to_thread(_do_index)
    except Exception as exc:
        if not already_existed:
            file_path.unlink(missing_ok=True)
        return None, f"Erreur d'indexation : {exc}"

    return _IndexResult(chunk_total), None


async def _stream_upload(
    project_id: str,
    files: list[UploadFile],
    files_dir: Path,
) -> AsyncGenerator[str, None]:
    # Buffer all uploads, then expand any ZIP archives
    raw_buffered: list[tuple[str, bytes]] = [
        (upload.filename or "unknown", await upload.read()) for upload in files
    ]

    total_size = sum(len(content) for _, content in raw_buffered)
    if total_size > MAX_TOTAL_UPLOAD_SIZE:
        max_mb = MAX_TOTAL_UPLOAD_SIZE // 1024 // 1024
        err = f"Taille totale trop grande (max {max_mb} Mo par envoi)"
        yield _sse({"type": "error", "filename": "", "error": err})
        yield _sse({"type": "done"})
        return

    buffered: list[tuple[str, bytes]] = []
    zip_extracted: dict[str, int | str] = {}  # zip filename → count or error message

    for filename, content in raw_buffered:
        buffered.append((filename, content))
        if Path(filename).suffix.lower() == ".zip":
            try:
                extracted = _expand_zip(content)
                zip_extracted[filename] = len(extracted)
                buffered.extend(extracted)
            except Exception as exc:
                zip_extracted[filename] = str(exc)

    # Pre-pass: parse any .bib manifest and build lookup indices
    bib_by_filename: dict[str, BibtexEntry] = {}  # lowercase basename → entry
    bib_by_title: dict[str, BibtexEntry] = {}     # normalize_title() → entry
    bib_results: dict[str, int | str] = {}        # filename → items_count or error msg

    for filename, content in buffered:
        if Path(filename).suffix.lower() not in MANIFEST_EXTENSIONS:
            continue
        try:
            entries = parse_bibtex(content)
            bib_results[filename] = len(entries)
            for entry in entries:
                for hint in entry.file_hints:
                    bib_by_filename.setdefault(hint.lower(), entry)
                t = normalize_title(entry.title)
                if t:
                    bib_by_title.setdefault(t, entry)
        except Exception as exc:
            bib_results[filename] = str(exc)

    # Main pass: emit SSE events
    for filename, content in buffered:
        ext = Path(filename).suffix.lower()
        yield _sse({"type": "start", "filename": filename})

        if ext == ".zip":
            result = zip_extracted.get(filename)
            if isinstance(result, str):
                yield _sse({"type": "error", "filename": filename, "error": result})
            else:
                yield _sse({"type": "result", "filename": filename, "extracted_count": result or 0})
            continue

        if ext in MANIFEST_EXTENSIONS:
            bib_result = bib_results.get(filename)
            if isinstance(bib_result, str):
                yield _sse({"type": "error", "filename": filename, "error": bib_result})
            else:
                count = bib_result or 0
                yield _sse({"type": "result", "filename": filename, "items_parsed": count})
            continue

        if ext not in SUPPORTED_EXTENSIONS:
            supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
            err_msg = f"Format non supporté. Formats acceptés : {supported}"
            yield _sse({"type": "error", "filename": filename, "error": err_msg})
            continue

        if len(content) > MAX_FILE_SIZE:
            max_mb = MAX_FILE_SIZE // 1024 // 1024
            err_msg = f"Fichier trop volumineux (max {max_mb} Mo)"
            yield _sse({"type": "error", "filename": filename, "error": err_msg})
            continue

        file_path = files_dir / filename
        already_existed = file_path.exists()
        file_path.write_bytes(content)

        # Resolve the best BibTeX entry: first by filename, then by parsed title.
        bib_hint: BibtexEntry | None = bib_by_filename.get(filename.lower())
        if bib_hint is None and bib_by_title:
            # Quick parse to get title for title-based lookup; errors handled later
            # inside _parse_and_index_file (no double-reporting).
            try:
                _quick = parse(filename, content)
                bib_hint = bib_by_title.get(normalize_title(_quick.title or ""))
            except Exception:
                pass

        index_result, index_err = await _parse_and_index_file(
            project_id, filename, content, file_path, already_existed,
            bib=bib_hint,
        )
        if index_result is None:
            assert index_err is not None
            yield _sse({"type": "error", "filename": filename, "error": index_err})
            continue

        stem = Path(filename).stem
        result_data: dict[str, object] = {
            "type": "result",
            "filename": filename,
            "stem": stem,
            "chunks_indexed": index_result.chunk_total,
            "already_existed": already_existed,
        }
        yield _sse(result_data)

    yield _sse({"type": "done"})


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
    # Internal ChromaDB keys that must never be overwritten via PATCH
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


async def _stream_url_import(
    project_id: str,
    url: str,
    files_dir: Path,
) -> AsyncGenerator[str, None]:
    # NOTE: This endpoint is NOT idempotent. Each call downloads the remote
    # resource and writes a new file with a timestamp-based stem, even if the
    # same URL was already imported. Deduplication (e.g. by URL hash) is not
    # implemented — importing the same URL twice creates two separate entries.
    yield _sse({"type": "start", "filename": url})

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; papers-helper/1.0; +https://github.com/papers-helper)"
        }
        async with httpx.AsyncClient() as client:
            response = await client.get(url, follow_redirects=True, timeout=30, headers=headers)
    except Exception as exc:
        yield _sse({"type": "error", "filename": url, "error": str(exc)})
        yield _sse({"type": "done"})
        return

    if response.status_code >= 400:
        yield _sse({"type": "error", "filename": url, "error": f"HTTP {response.status_code}"})
        yield _sse({"type": "done"})
        return

    content_type = response.headers.get("content-type", "").split(";")[0].strip()
    stem = _url_to_stem(url)
    stem = f"{stem}_{int(time.time())}"[:80]

    # Detect format from content-type or URL extension
    url_path = urlparse(url).path
    url_ext = Path(url_path).suffix.lower()

    raw_content = response.content
    inferred_filename = f"{stem}{url_ext or '.html'}"

    if content_type == "application/pdf" or url_ext == ".pdf":
        inferred_filename = f"{stem}.pdf"
    elif content_type in ("text/html", "text/plain") or not url_ext:
        inferred_filename = f"{stem}.html"
    elif url_ext in SUPPORTED_EXTENSIONS:
        inferred_filename = f"{stem}{url_ext}"
    else:
        err = f"Type de contenu non supporté : {content_type}"
        yield _sse({"type": "error", "filename": url, "error": err})
        yield _sse({"type": "done"})
        return

    if len(raw_content) > MAX_FILE_SIZE:
        max_mb = MAX_FILE_SIZE // 1024 // 1024
        err = f"Fichier trop volumineux (max {max_mb} Mo)"
        yield _sse({"type": "error", "filename": url, "error": err})
        yield _sse({"type": "done"})
        return

    file_path = files_dir / inferred_filename
    file_path.write_bytes(raw_content)

    index_result, index_err = await _parse_and_index_file(
        project_id, inferred_filename, raw_content, file_path, already_existed=False,
        pdf_title_fallback=url,
    )
    if index_result is None:
        assert index_err is not None
        yield _sse({"type": "error", "filename": url, "error": index_err})
        yield _sse({"type": "done"})
        return

    result_data: dict[str, object] = {
        "type": "result",
        "filename": url,
        "stem": stem,
        "chunks_indexed": index_result.chunk_total,
        "already_existed": False,
    }
    yield _sse(result_data)
    yield _sse({"type": "done"})


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
