import asyncio
import json
import re
from io import BytesIO
from pathlib import Path
from typing import AsyncGenerator

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from pypdf import PdfReader

from app.chroma import get_collection
from app.config import DATA_DIR

router = APIRouter(prefix="/papers", tags=["papers"])

MAX_PDF_SIZE = 50 * 1024 * 1024  # 50 MB


class PaperResult(BaseModel):
    filename: str
    chunks_indexed: int
    already_existed: bool


class UploadError(BaseModel):
    filename: str
    error: str


class UploadResponse(BaseModel):
    results: list[PaperResult]
    errors: list[UploadError]


def normalize_text(text: str) -> str:
    # "algo-\nrithm" → "algorithm"
    text = re.sub(r"-\n", "", text)
    # single \n (soft wrap) → space ; double \n (paragraph) preserved
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    # collapse extra spaces
    text = re.sub(r" {2,}", " ", text)
    # collapse 3+ blank lines → 2
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


def _extract_pdf_metadata(reader: PdfReader) -> tuple[str, str, str]:
    """Returns (pdf_title, author, year) as strings, empty string if unknown."""
    meta = reader.metadata or {}

    title = str(meta.get("/Title") or meta.get("title") or "").strip()
    author = str(meta.get("/Author") or meta.get("author") or "").strip()

    raw_date = str(meta.get("/CreationDate") or meta.get("/ModDate") or "")
    year = ""
    if raw_date:
        m = re.search(r"(\d{4})", raw_date)
        if m:
            candidate = m.group(1)
            if 1900 <= int(candidate) <= 2100:
                year = candidate

    return title, author, year


class PaperInfo(BaseModel):
    stem: str
    filename: str
    chunk_total: int
    pdf_title: str
    author: str
    year: str


@router.get("/", response_model=list[PaperInfo])
async def list_papers() -> list[PaperInfo]:
    def _fetch() -> list[PaperInfo]:
        collection = get_collection()
        result = collection.get(include=["metadatas"])
        papers: dict[str, PaperInfo] = {}
        for meta in result["metadatas"] or []:
            stem = str(meta["source_stem"])
            if stem not in papers:
                papers[stem] = PaperInfo(
                    stem=stem,
                    filename=str(meta["source_filename"]),
                    chunk_total=int(meta["chunk_total"]),
                    pdf_title=str(meta.get("pdf_title", "")),
                    author=str(meta.get("author", "")),
                    year=str(meta.get("year", "")),
                )
        return list(papers.values())

    return await asyncio.to_thread(_fetch)


class ChunkInfo(BaseModel):
    id: str
    chunk_index: int
    word_count: int
    text: str


@router.get("/{stem}/chunks", response_model=list[ChunkInfo])
async def get_paper_chunks(stem: str) -> list[ChunkInfo]:
    def _fetch() -> list[ChunkInfo]:
        collection = get_collection()
        result = collection.get(
            where={"source_stem": stem},
            include=["documents", "metadatas"],
        )
        chunks = []
        for id_, doc, meta in zip(result["ids"], result["documents"] or [], result["metadatas"] or []):
            chunks.append(ChunkInfo(
                id=id_,
                chunk_index=int(meta["chunk_index"]),
                word_count=int(meta["word_count"]),
                text=doc,
            ))
        return sorted(chunks, key=lambda c: c.chunk_index)

    return await asyncio.to_thread(_fetch)


@router.get("/{stem}/file")
async def get_paper_file(stem: str) -> FileResponse:
    def _get_filename() -> str | None:
        collection = get_collection()
        result = collection.get(where={"source_stem": stem}, include=["metadatas"])
        if not result["ids"]:
            return None
        return str(result["metadatas"][0]["source_filename"])

    filename = await asyncio.to_thread(_get_filename)
    if not filename:
        raise HTTPException(status_code=404, detail="Paper not found")

    pdf_path = DATA_DIR / "pdfs" / filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(str(pdf_path), media_type="application/pdf")


@router.post("/upload", response_model=UploadResponse)
async def upload_papers(files: list[UploadFile] = File(...)) -> UploadResponse:
    pdfs_dir = DATA_DIR / "pdfs"
    pdfs_dir.mkdir(parents=True, exist_ok=True)

    collection = get_collection()

    results: list[PaperResult] = []
    errors: list[UploadError] = []

    for upload in files:
        filename = upload.filename or "unknown.pdf"

        if not filename.lower().endswith(".pdf"):
            errors.append(UploadError(filename=filename, error="Not a PDF file"))
            continue

        pdf_path = pdfs_dir / filename
        already_existed = pdf_path.exists()

        content = await upload.read()

        if len(content) > MAX_PDF_SIZE:
            errors.append(UploadError(filename=filename, error=f"File too large (max {MAX_PDF_SIZE // 1024 // 1024} MB)"))
            continue

        pdf_path.write_bytes(content)

        try:
            reader = PdfReader(BytesIO(content))
            pdf_title, author, year = _extract_pdf_metadata(reader)
            raw = "\n\n".join(page.extract_text() or "" for page in reader.pages)
            text = normalize_text(raw)
        except Exception as exc:
            errors.append(UploadError(filename=filename, error=f"PDF parse error: {exc}"))
            continue

        if not text:
            errors.append(UploadError(filename=filename, error="PDF returned empty text"))
            continue

        chunks = chunk_text(text)
        stem = Path(filename).stem

        chunk_total = await asyncio.to_thread(
            _index_chunks, collection, stem, filename, chunks, pdf_title, author, year
        )

        results.append(
            PaperResult(
                filename=filename,
                chunks_indexed=chunk_total,
                already_existed=already_existed,
            )
        )

    return UploadResponse(results=results, errors=errors)


def _index_chunks(
    collection,
    stem: str,
    filename: str,
    chunks: list[str],
    pdf_title: str = "",
    author: str = "",
    year: str = "",
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
            }
            for i, chunk in enumerate(chunks)
        ],
    )
    return chunk_total


async def _stream_upload(
    files: list[UploadFile],
    pdfs_dir: Path,
) -> AsyncGenerator[str, None]:
    for upload in files:
        filename = upload.filename or "unknown.pdf"

        yield f"data: {json.dumps({'type': 'start', 'filename': filename})}\n\n"

        if not filename.lower().endswith(".pdf"):
            yield f"data: {json.dumps({'type': 'error', 'filename': filename, 'error': 'Not a PDF file'})}\n\n"
            continue

        pdf_path = pdfs_dir / filename
        already_existed = pdf_path.exists()
        content = await upload.read()

        if len(content) > MAX_PDF_SIZE:
            yield f"data: {json.dumps({'type': 'error', 'filename': filename, 'error': f'File too large (max {MAX_PDF_SIZE // 1024 // 1024} MB)'})}\n\n"
            continue

        pdf_path.write_bytes(content)

        try:
            reader = PdfReader(BytesIO(content))
            pdf_title, author, year = _extract_pdf_metadata(reader)
            raw = "\n\n".join(page.extract_text() or "" for page in reader.pages)
            text = normalize_text(raw)
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'filename': filename, 'error': f'PDF parse error: {exc}'})}\n\n"
            continue

        if not text:
            yield f"data: {json.dumps({'type': 'error', 'filename': filename, 'error': 'PDF returned empty text'})}\n\n"
            continue

        chunks = chunk_text(text)
        stem = Path(filename).stem

        try:
            chunk_total = await asyncio.to_thread(
                lambda s=stem, f=filename, c=chunks, t=pdf_title, a=author, y=year: (
                    _index_chunks(get_collection(), s, f, c, t, a, y)
                )
            )
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'filename': filename, 'error': f'Indexation error: {exc}'})}\n\n"
            continue

        yield f"data: {json.dumps({'type': 'result', 'filename': filename, 'stem': stem, 'chunks_indexed': chunk_total, 'already_existed': already_existed})}\n\n"

    yield f"data: {json.dumps({'type': 'done'})}\n\n"


@router.post("/upload/stream")
async def upload_papers_stream(files: list[UploadFile] = File(...)) -> StreamingResponse:
    pdfs_dir = DATA_DIR / "pdfs"
    pdfs_dir.mkdir(parents=True, exist_ok=True)
    return StreamingResponse(
        _stream_upload(files, pdfs_dir),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/{stem}", status_code=204)
async def delete_paper(stem: str) -> None:
    def _delete() -> str | None:
        collection = get_collection()
        existing = collection.get(where={"source_stem": stem}, include=["metadatas"])
        if not existing["ids"]:
            return None
        filename = existing["metadatas"][0]["source_filename"]
        collection.delete(ids=existing["ids"])
        return filename

    filename = await asyncio.to_thread(_delete)
    if filename:
        pdf_path = DATA_DIR / "pdfs" / filename
        if pdf_path.exists():
            pdf_path.unlink()
