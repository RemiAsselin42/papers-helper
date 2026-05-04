from __future__ import annotations

import asyncio
import io
import json
import re
import time
import zipfile
from collections.abc import AsyncGenerator
from pathlib import Path
from urllib.parse import urlparse

import chromadb
import httpx
from fastapi import UploadFile

from app.chroma import get_collection
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

MAX_TOTAL_UPLOAD_SIZE = 200 * 1024 * 1024  # 200 MB across all files in one request


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


class _IndexResult:
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
    pdf_title_fallback: str = "",
) -> tuple[_IndexResult, None] | tuple[None, str]:
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


def _expand_zip(content: bytes) -> list[tuple[str, bytes]]:
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


def _url_to_stem(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.replace(".", "_")
    path = parsed.path.strip("/").replace("/", "__")
    raw = f"{host}__{path}" if path else host
    return re.sub(r"[^a-zA-Z0-9_-]", "_", raw)[:80]


async def _stream_upload(
    project_id: str,
    files: list[UploadFile],
    files_dir: Path,
) -> AsyncGenerator[str, None]:
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
    zip_extracted: dict[str, int | str] = {}

    for filename, content in raw_buffered:
        buffered.append((filename, content))
        if Path(filename).suffix.lower() == ".zip":
            try:
                extracted = _expand_zip(content)
                zip_extracted[filename] = len(extracted)
                buffered.extend(extracted)
            except Exception as exc:
                zip_extracted[filename] = str(exc)

    bib_by_filename: dict[str, BibtexEntry] = {}
    bib_by_title: dict[str, BibtexEntry] = {}
    bib_results: dict[str, int | str] = {}

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

        bib_hint: BibtexEntry | None = bib_by_filename.get(filename.lower())
        if bib_hint is None and bib_by_title:
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


async def _stream_url_import(
    project_id: str,
    url: str,
    files_dir: Path,
) -> AsyncGenerator[str, None]:
    # NOTE: Not idempotent — importing the same URL twice creates two entries.
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
