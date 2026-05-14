from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import time
import zipfile
from collections.abc import AsyncGenerator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import chromadb
import httpx
from fastapi import UploadFile

from app.chroma import evict_collection, get_collection
from app.graph import graph_add_source, graph_rebuild
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

log = logging.getLogger(__name__)

MAX_TOTAL_UPLOAD_SIZE = 200 * 1024 * 1024  # 200 MB across all files in one request


SIDECAR_SUFFIX = ".meta.json"


# Per-source metadata persisted as <files_dir>/<stem>.meta.json so a file can be
# imported (and edited) even when embedding is unavailable. When the source is
# indexed in Chroma, both stores are kept in sync.
@dataclass
class SidecarMeta:
    stem: str
    filename: str
    source_type: str = "document"
    pdf_title: str = ""
    author: str = ""
    year: str = ""
    authors_json: str = ""
    publication: str = ""
    doi: str = ""
    abstract: str = ""
    notes: str = ""
    categories: str = ""
    index_error: str = ""
    indexed_at: str = ""
    # Concepts extracted once by the LLM (see app.graph.concepts) and cached
    # here as a JSON-encoded list so subsequent graph operations are free.
    # Derived from content; never user-edited (absent from EDITABLE_META_KEYS).
    concepts_json: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Fields the user can edit via PATCH /papers/{stem}. Kept in sync with the
# UpdateMetadataRequest model in routes/papers.py.
EDITABLE_META_KEYS: frozenset[str] = frozenset(
    {
        "pdf_title",
        "author",
        "authors_json",
        "year",
        "publication",
        "doi",
        "abstract",
        "notes",
        "categories",
    }
)


def sidecar_path(files_dir: Path, stem: str) -> Path:
    return files_dir / f"{stem}{SIDECAR_SUFFIX}"


def read_sidecar(files_dir: Path, stem: str) -> SidecarMeta | None:
    p = sidecar_path(files_dir, stem)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    fields = set(SidecarMeta.__dataclass_fields__.keys())
    cleaned = {k: v for k, v in raw.items() if k in fields and v is not None}
    cleaned.setdefault("stem", stem)
    cleaned.setdefault("filename", f"{stem}")
    return SidecarMeta(**cleaned)


def write_sidecar(files_dir: Path, meta: SidecarMeta) -> None:
    files_dir.mkdir(parents=True, exist_ok=True)
    sidecar_path(files_dir, meta.stem).write_text(
        json.dumps(meta.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _sse(data: dict[str, object]) -> str:
    return f"data: {json.dumps(data)}\n\n"


def normalize_text(text: str) -> str:
    text = re.sub(r"-\n", "", text)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_oversized_paragraph(para: str, max_words: int) -> list[str]:
    """Split a paragraph that exceeds *max_words* into chunks of at most that
    many words. Preserves word order; doesn't try to be sentence-aware.
    Used as a safety net so no single chunk can blow Ollama's embedding
    context window (default 2048 tokens ≈ a few hundred dense words).
    """
    words = para.split()
    if len(words) <= max_words:
        return [para]
    return [" ".join(words[i : i + max_words]) for i in range(0, len(words), max_words)]


def chunk_text(text: str, target_words: int = 500) -> list[str]:
    # Hard cap per chunk — slightly above target_words to keep paragraph-aware
    # packing flexible, but well under any reasonable embedding context window.
    max_words_per_chunk = target_words * 2

    paragraphs: list[str] = []
    for raw in text.split("\n\n"):
        para = raw.strip()
        if not para:
            continue
        paragraphs.extend(_split_oversized_paragraph(para, max_words_per_chunk))

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
    notes: str = "",
    categories: str = "",
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
                "notes": notes,
                "categories": categories,
            }
            for i, chunk in enumerate(chunks)
        ],
    )
    return chunk_total


@dataclass
class _ParsedSource:
    """Result of parsing a file, before any embedding attempt."""

    text: str
    chunks: list[str]
    meta: SidecarMeta


def _parse_source(
    filename: str,
    content: bytes,
    *,
    bib: BibtexEntry | None = None,
    pdf_title_fallback: str = "",
    sidecar_overrides: SidecarMeta | None = None,
) -> _ParsedSource:
    """Pure parse step. Raises on parse failure. Never touches Chroma."""
    result: ParseResult = parse(filename, content)
    text = normalize_text(result.text)
    if not text:
        raise ValueError("Aucun texte extrait du fichier")

    chunks = chunk_text(text)
    stem = Path(filename).stem

    pdf_title = (bib.title if bib else result.title) or pdf_title_fallback
    meta = SidecarMeta(
        stem=stem,
        filename=filename,
        source_type=result.source_type,
        pdf_title=pdf_title,
        author=bib.author if bib else result.author,
        year=bib.year if bib else result.year,
        authors_json=bib.authors_json if bib else "",
        publication=bib.publication if bib else "",
        doi=bib.doi if bib else "",
        abstract=bib.abstract if bib else "",
    )

    # Preserve user-edited fields (notes, categories, hand-edited metadata) if a
    # sidecar already existed for this stem before reparsing.
    if sidecar_overrides is not None:
        for key in EDITABLE_META_KEYS:
            existing = getattr(sidecar_overrides, key, "")
            if existing:
                setattr(meta, key, existing)
        # concepts_json is content-derived (LLM keyword extraction) but cached
        # in the sidecar so subsequent graph operations are free. Preserve it
        # through a reparse so the LLM cost isn't paid again unnecessarily.
        if sidecar_overrides.concepts_json:
            meta.concepts_json = sidecar_overrides.concepts_json

    return _ParsedSource(text=text, chunks=chunks, meta=meta)


def _attempt_index(project_id: str, parsed: _ParsedSource) -> int:
    """Index `parsed` into the project's Chroma collection. Raises on failure."""
    collection = get_collection(project_id)
    return _index_chunks(
        collection,
        parsed.meta.stem,
        parsed.meta.filename,
        parsed.chunks,
        pdf_title=parsed.meta.pdf_title,
        author=parsed.meta.author,
        year=parsed.meta.year,
        source_type=parsed.meta.source_type,
        authors_json=parsed.meta.authors_json,
        publication=parsed.meta.publication,
        doi=parsed.meta.doi,
        abstract=parsed.meta.abstract,
        notes=parsed.meta.notes,
        categories=parsed.meta.categories,
    )


@dataclass
class _ImportOutcome:
    chunk_total: int
    indexed: bool
    index_error: str = ""
    already_existed: bool = False


async def _import_one(
    project_id: str,
    filename: str,
    content: bytes,
    files_dir: Path,
    *,
    already_existed: bool,
    bib: BibtexEntry | None = None,
    pdf_title_fallback: str = "",
) -> tuple[_ImportOutcome, None] | tuple[None, str]:
    """Save the file (already done by caller) and try to index it. Returns the
    outcome (always success on parse) or a hard error string if parsing fails.

    On parse failure the caller's freshly-written file is removed when it
    didn't pre-exist. On index failure the file is kept and a sidecar is
    written with `index_error` set.
    """
    file_path = files_dir / filename
    stem = Path(filename).stem
    existing_sidecar = read_sidecar(files_dir, stem)

    try:
        parsed = _parse_source(
            filename,
            content,
            bib=bib,
            pdf_title_fallback=pdf_title_fallback,
            sidecar_overrides=existing_sidecar,
        )
    except Exception as exc:
        if not already_existed:
            file_path.unlink(missing_ok=True)
        return None, f"Erreur d'extraction : {exc}"

    # Write sidecar before attempting indexing so the source is visible even
    # if indexing fails afterwards.
    write_sidecar(files_dir, parsed.meta)

    try:
        chunk_total = await asyncio.to_thread(_attempt_index, project_id, parsed)
    except Exception as exc:
        # Update sidecar with the error so the UI can show it on the source row.
        parsed.meta.index_error = f"{type(exc).__name__}: {exc}"
        parsed.meta.indexed_at = ""
        write_sidecar(files_dir, parsed.meta)
        return _ImportOutcome(
            chunk_total=0,
            indexed=False,
            index_error=parsed.meta.index_error,
            already_existed=already_existed,
        ), None

    parsed.meta.index_error = ""
    parsed.meta.indexed_at = str(int(time.time()))
    write_sidecar(files_dir, parsed.meta)
    return _ImportOutcome(
        chunk_total=chunk_total,
        indexed=True,
        already_existed=already_existed,
    ), None


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


def _result_event(
    *,
    filename: str,
    stem: str,
    outcome: _ImportOutcome,
) -> dict[str, object]:
    return {
        "type": "result",
        "filename": filename,
        "stem": stem,
        "chunks_indexed": outcome.chunk_total,
        "indexed": outcome.indexed,
        "index_error": outcome.index_error,
        "already_existed": outcome.already_existed,
    }


async def _graph_update_event(project_id: str, filename: str, stem: str) -> str | None:
    """Run the graph add hook for a freshly-indexed source and return the SSE
    event line to yield. Best-effort: any failure logs a warning and returns
    None so the ingestion stream keeps moving."""
    try:
        result = await graph_add_source(project_id, stem)
    except Exception as exc:  # noqa: BLE001 — must not interrupt ingestion
        log.warning("graph hook failed for %s/%s: %s", project_id, stem, exc)
        return None
    return _sse(
        {
            "type": "graph_updated",
            "filename": filename,
            "stem": stem,
            "added": bool(result.get("added", False)),
            # Surfaced to the frontend so the user gets a visible reason when
            # a paper silently fails to enter the graph (e.g. no sidecar could
            # be synthesised). Empty string when added=True.
            "reason": str(result.get("reason", "") or ""),
            "concepts": int(result.get("concepts", 0)),
            "semantic_edges": int(result.get("semantic_edges", 0)),
        }
    )


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

        outcome, parse_err = await _import_one(
            project_id,
            filename,
            content,
            files_dir,
            already_existed=already_existed,
            bib=bib_hint,
        )
        if outcome is None:
            assert parse_err is not None
            yield _sse({"type": "error", "filename": filename, "error": parse_err})
            continue

        stem = Path(filename).stem
        yield _sse(_result_event(filename=filename, stem=stem, outcome=outcome))
        if outcome.indexed:
            ev = await _graph_update_event(project_id, filename, stem)
            if ev:
                yield ev

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

    outcome, parse_err = await _import_one(
        project_id,
        inferred_filename,
        raw_content,
        files_dir,
        already_existed=False,
        pdf_title_fallback=url,
    )
    if outcome is None:
        assert parse_err is not None
        yield _sse({"type": "error", "filename": url, "error": parse_err})
        yield _sse({"type": "done"})
        return

    # Surface the URL as the event's filename so the frontend toast stays
    # consistent with the upload progress view.
    yield _sse(_result_event(filename=url, stem=stem, outcome=outcome))
    if outcome.indexed:
        ev = await _graph_update_event(project_id, url, stem)
        if ev:
            yield ev
    yield _sse({"type": "done"})


async def _stream_single_reindex(
    project_id: str,
    files_dir: Path,
    stem: str,
    file_path: Path,
) -> AsyncGenerator[str, None]:
    """Retry indexing for a single source previously imported without success.
    Reuses the existing sidecar metadata, only the embedding step is rerun.
    """
    filename = file_path.name
    yield _sse({"type": "start", "filename": filename})

    try:
        content = file_path.read_bytes()
    except Exception as exc:
        yield _sse({"type": "error", "filename": filename, "error": str(exc)})
        yield _sse({"type": "done"})
        return

    outcome, parse_err = await _import_one(
        project_id,
        filename,
        content,
        files_dir,
        already_existed=True,
    )
    if outcome is None:
        assert parse_err is not None
        yield _sse({"type": "error", "filename": filename, "error": parse_err})
        yield _sse({"type": "done"})
        return

    yield _sse(_result_event(filename=filename, stem=stem, outcome=outcome))
    if outcome.indexed:
        ev = await _graph_update_event(project_id, filename, stem)
        if ev:
            yield ev
    yield _sse({"type": "done"})


_RESTORABLE_META = frozenset(
    {
        "pdf_title",
        "author",
        "year",
        "authors_json",
        "publication",
        "doi",
        "abstract",
        "notes",
        "categories",
    }
)


def iter_source_files(project_dir: Path) -> list[Path]:
    """List every importable source file across the legacy ``pdfs/`` and the
    current ``files/`` directories.
    """
    out: list[Path] = []
    seen: set[str] = set()
    for subdir in ("files", "pdfs"):
        d = project_dir / subdir
        if not d.exists():
            continue
        for f in d.iterdir():
            if not f.is_file():
                continue
            if f.name.startswith("."):
                continue
            if f.name.endswith(SIDECAR_SUFFIX):
                continue
            if Path(f.name).suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            if f.name in seen:
                continue
            seen.add(f.name)
            out.append(f)
    return out


async def _stream_reindex(project_id: str, files_dir: Path) -> AsyncGenerator[str, None]:
    # 1. Export per-stem metadata before dropping the collection.
    def _export() -> dict[str, dict[str, Any]]:
        col = get_collection(project_id)
        result = col.get(include=["metadatas"])
        by_stem: dict[str, dict[str, Any]] = {}
        for meta in result["metadatas"] or []:
            stem = str(meta["source_stem"])
            by_stem.setdefault(stem, dict(meta))
        return by_stem

    saved_meta = await asyncio.to_thread(_export)

    # 2. Drop + recreate the collection so the new embed model is applied.
    def _reset() -> None:
        evict_collection(project_id)
        get_collection(project_id)

    await asyncio.to_thread(_reset)

    # 3. Collect source files across legacy + current directories.
    project_dir = files_dir.parent
    source_files = iter_source_files(project_dir)

    yield _sse({"type": "start_reindex", "total": len(source_files)})

    indexed = 0
    failed = 0
    pending_patches: dict[str, dict[str, Any]] = {}

    for file_path in source_files:
        filename = file_path.name
        yield _sse({"type": "start", "filename": filename})

        try:
            content = file_path.read_bytes()
        except Exception as exc:
            yield _sse({"type": "error", "filename": filename, "error": str(exc)})
            failed += 1
            continue

        outcome, parse_err = await _import_one(
            project_id,
            filename,
            content,
            files_dir,
            already_existed=True,
        )
        if outcome is None:
            assert parse_err is not None
            yield _sse({"type": "error", "filename": filename, "error": parse_err})
            failed += 1
            continue

        stem = Path(filename).stem
        if stem in saved_meta:
            patch = {k: v for k, v in saved_meta[stem].items() if k in _RESTORABLE_META}
            if patch:
                pending_patches[stem] = patch

        if outcome.indexed:
            indexed += 1
        else:
            failed += 1

        yield _sse(_result_event(filename=filename, stem=stem, outcome=outcome))

    # 4. Restore user-edited metadata (notes, BibTeX fields, categories) in a single pass.
    if pending_patches:

        def _restore_all(patches: dict[str, dict[str, Any]] = pending_patches) -> None:
            col = get_collection(project_id)
            for stem, patch in patches.items():
                res = col.get(where={"source_stem": stem}, include=["metadatas"])
                if res["ids"]:
                    updated = [{**m, **patch} for m in (res["metadatas"] or [])]
                    col.update(ids=res["ids"], metadatas=updated)  # type: ignore[arg-type]

        await asyncio.to_thread(_restore_all)

    # 5. Rebuild the knowledge graph from the fresh index. Events are
    # `graph_*`-prefixed so the frontend can render them separately from
    # ingestion events. Best-effort: a rebuild failure must not mask the
    # ingestion-level `done` event the UI is waiting on.
    try:
        async for ev in graph_rebuild(project_id):
            yield ev
    except Exception as exc:  # noqa: BLE001 — graph rebuild is enrichment
        log.warning("graph rebuild failed for project %s: %s", project_id, exc)

    yield _sse({"type": "done", "total": indexed, "failed": failed})
