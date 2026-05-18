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
from app.config import MAX_CHUNK_CHARS
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
from app.settings import resolve_settings

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


def strip_title_braces(meta: SidecarMeta) -> bool:
    """Remove every `{` and `}` character from the title while keeping the
    inner text intact (Zotero used to wrap segments like
    `"Title {with sub-info}"` — we just want plain `"Title with sub-info"`
    now that the brace-extraction feature is gone). Whitespace runs are
    collapsed. Mutates `meta` in place; returns True iff the title changed.
    Idempotent on already-clean titles.
    """
    if "{" not in meta.pdf_title and "}" not in meta.pdf_title:
        return False
    cleaned = re.sub(r"\s{2,}", " ", meta.pdf_title.replace("{", "").replace("}", "")).strip()
    if cleaned == meta.pdf_title:
        return False
    meta.pdf_title = cleaned
    return True


def _split_oversized_paragraph(para: str, max_words: int, max_chars: int) -> list[str]:
    """Split *para* so every piece holds at most *max_words* words AND at most
    *max_chars* characters. Preserves word order; not sentence-aware.

    The char bound is the real safety net: PDF extraction can glue words
    together, so a word-bounded piece can still exceed the embedding model's
    token budget. A piece still too long after word grouping (e.g. one
    unbroken string with no spaces) is hard-sliced by character.
    """
    if len(para) <= max_chars and len(para.split()) <= max_words:
        return [para]

    pieces: list[str] = []
    current: list[str] = []
    current_chars = 0
    for word in para.split():
        added = len(word) + (1 if current else 0)
        if current and (len(current) >= max_words or current_chars + added > max_chars):
            pieces.append(" ".join(current))
            current = []
            current_chars = 0
            added = len(word)
        current.append(word)
        current_chars += added
    if current:
        pieces.append(" ".join(current))

    # A single word longer than the char cap survives the loop above intact —
    # hard-slice anything still over the limit so no piece can blow the context.
    out: list[str] = []
    for piece in pieces:
        if len(piece) <= max_chars:
            out.append(piece)
        else:
            out.extend(piece[i : i + max_chars] for i in range(0, len(piece), max_chars))
    return out


def chunk_text(
    text: str, target_words: int = 500, max_chunk_chars: int = MAX_CHUNK_CHARS
) -> list[str]:
    # Hard cap per chunk — slightly above target_words to keep paragraph-aware
    # packing flexible. `max_chunk_chars` is the embedding-context safety net;
    # it comes from the project's "granularité" setting (see app.settings).
    max_words_per_chunk = target_words * 2

    paragraphs: list[str] = []
    for raw in text.split("\n\n"):
        para = raw.strip()
        if not para:
            continue
        paragraphs.extend(_split_oversized_paragraph(para, max_words_per_chunk, max_chunk_chars))

    chunks: list[str] = []
    bucket: list[str] = []
    bucket_words = 0
    bucket_chars = 0

    for para in paragraphs:
        para_words = len(para.split())
        para_chars = len(para)
        # Flush on either bound: the word target shapes normal chunks, the char
        # cap guarantees no chunk can exceed the embedding context.
        over_words = bucket_words + para_words > target_words
        over_chars = bucket_chars + para_chars > max_chunk_chars
        if bucket and (over_words or over_chars):
            chunks.append("\n\n".join(bucket))
            bucket = []
            bucket_words = 0
            bucket_chars = 0
        bucket.append(para)
        bucket_words += para_words
        bucket_chars += para_chars + 2  # the "\n\n" join

    if bucket:
        chunks.append("\n\n".join(bucket))

    # Drop chunks with no real textual content — only punctuation, symbols or
    # zero-width / format characters left by bad PDF extraction. An embedding
    # model can return a NaN-bearing vector for such degenerate input, which
    # Ollama then fails to JSON-encode (HTTP 500). `\w` is Unicode-aware, so
    # accented words and CJK are kept.
    return [chunk for chunk in chunks if re.search(r"\w", chunk)]


def _is_degenerate_embed_error(exc: Exception) -> bool:
    """Whether the embedder rejected a chunk as degenerate (no real content).

    A NaN-bearing vector (Ollama: "json: unsupported value: NaN", HTTP 500) is
    produced reproducibly for punctuation/symbol-only input. Such a chunk has
    nothing to embed, so :func:`_add_chunks_resilient` drops it.
    """
    msg = str(exc).lower()
    return "nan" in msg or "unsupported value" in msg


def _is_context_overflow_error(exc: Exception) -> bool:
    """Whether the embedder rejected a chunk for exceeding its context window.

    Ollama returns HTTP 400 with a message like "input length exceeds context
    length" when a chunk packs more tokens than the model loads. This is what a
    too-coarse "granularité" setting triggers (a large ``max_chunk_chars``
    paired with a small-context embed model — e.g. RAPIDE with the default
    ``nomic-embed-text``). Unlike a degenerate chunk the text is real, so
    :func:`_add_chunks_resilient` re-splits it smaller and retries rather than
    dropping it.
    """
    msg = str(exc).lower()
    return "context length" in msg or "context window" in msg or "exceeds context" in msg


def _is_skippable_embed_error(exc: Exception) -> bool:
    """Whether an embedding failure is chunk-specific and deterministic — it
    recurs for that exact chunk, so isolating it is correct.

    Two kinds, handled differently by :func:`_add_chunks_resilient`: a
    degenerate chunk (:func:`_is_degenerate_embed_error`) is dropped; a
    context-overflow chunk (:func:`_is_context_overflow_error`) is re-split and
    retried. Transient failures (timeout, connection reset) are NOT skippable:
    they must propagate so the whole document is failed and retried.
    """
    return _is_degenerate_embed_error(exc) or _is_context_overflow_error(exc)


def _add_chunks_resilient(
    collection: chromadb.Collection,
    ids: list[str],
    documents: list[str],
    metadatas: list[dict[str, Any]],
) -> int:
    """Add chunks to Chroma, isolating any that the embedder deterministically
    rejects. On a skippable failure (see :func:`_is_skippable_embed_error`) the
    batch is bisected down to the offending chunk(s): a degenerate chunk is
    dropped, a chunk that overflows the embedding context window is re-split
    smaller and retried — so neither a single bad chunk nor a too-coarse
    granularity setting can sink the whole document. Returns the count actually
    added. Re-raises transient failures unchanged.
    """
    if not ids:
        return 0
    try:
        collection.add(ids=ids, documents=documents, metadatas=metadatas)  # type: ignore[arg-type]
        return len(ids)
    except Exception as exc:
        if not _is_skippable_embed_error(exc):
            raise
        if len(ids) == 1:
            if _is_context_overflow_error(exc):
                return _resplit_oversized_chunk(collection, ids[0], documents[0], metadatas[0], exc)
            log.warning("skipping unembeddable chunk %s: %s", ids[0], exc)
            return 0
        mid = len(ids) // 2
        added = _add_chunks_resilient(collection, ids[:mid], documents[:mid], metadatas[:mid])
        added += _add_chunks_resilient(collection, ids[mid:], documents[mid:], metadatas[mid:])
        return added


def _resplit_oversized_chunk(
    collection: chromadb.Collection,
    chunk_id: str,
    document: str,
    metadata: dict[str, Any],
    exc: Exception,
) -> int:
    """Recover a single chunk too long for the embedding model's context
    window by halving it and re-adding both pieces.

    The halves go back through :func:`_add_chunks_resilient`, so an oversized
    piece is halved again until each one fits. Re-splitting preserves the text
    — dropping it would silently lose content — letting a coarse "granularité"
    setting degrade gracefully instead of failing the document. A chunk too
    short to halve is dropped as a last resort.
    """
    half = len(document) // 2
    if half == 0:
        log.warning("skipping unsplittable oversized chunk %s: %s", chunk_id, exc)
        return 0
    sub_ids = [f"{chunk_id}__s0", f"{chunk_id}__s1"]
    sub_docs = [document[:half], document[half:]]
    sub_metas = [dict(metadata), dict(metadata)]
    return _add_chunks_resilient(collection, sub_ids, sub_docs, sub_metas)


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
    ids = [f"{stem}__chunk_{i:04d}" for i in range(chunk_total)]
    metadatas: list[dict[str, Any]] = [
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
    ]
    # Returns the count actually stored — a chunk the embedder rejects with a
    # NaN vector is skipped rather than failing the whole document.
    return _add_chunks_resilient(collection, ids, list(chunks), metadatas)


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
    max_chunk_chars: int = MAX_CHUNK_CHARS,
) -> _ParsedSource:
    """Pure parse step. Raises on parse failure. Never touches Chroma.

    `max_chunk_chars` comes from the project's granularity setting; the default
    is used by callers (like Stage-1 import) whose chunks are discarded anyway.
    """
    result: ParseResult = parse(filename, content)
    text = normalize_text(result.text)
    if not text:
        raise ValueError("Aucun texte extrait du fichier")

    chunks = chunk_text(text, max_chunk_chars=max_chunk_chars)
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

    # Strip Zotero brace characters from the title; the inner words are part
    # of the title, only the `{` `}` themselves were ever decorative.
    strip_title_braces(meta)

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
    # Surfaced to the frontend so the auto-enrichment queue can skip
    # dimensions that already have content (BibTeX abstract, user-edited
    # categories) without an extra GET round-trip.
    has_abstract: bool = False
    has_categories: bool = False


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
            # Chunk size follows the project's granularity setting.
            max_chunk_chars=resolve_settings(project_id).max_chunk_chars,
        )
    except Exception as exc:
        if not already_existed:
            file_path.unlink(missing_ok=True)
        return None, f"Erreur d'extraction : {exc}"

    # Write sidecar before attempting indexing so the source is visible even
    # if indexing fails afterwards.
    write_sidecar(files_dir, parsed.meta)

    has_abstract = bool(parsed.meta.abstract.strip())
    has_categories = bool(parsed.meta.categories.strip())

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
            has_abstract=has_abstract,
            has_categories=has_categories,
        ), None

    parsed.meta.index_error = ""
    parsed.meta.indexed_at = str(int(time.time()))
    write_sidecar(files_dir, parsed.meta)
    return _ImportOutcome(
        chunk_total=chunk_total,
        indexed=True,
        already_existed=already_existed,
        has_abstract=has_abstract,
        has_categories=has_categories,
    ), None


async def _import_parse_only(
    filename: str,
    content: bytes,
    files_dir: Path,
    *,
    already_existed: bool,
    bib: BibtexEntry | None = None,
    pdf_title_fallback: str = "",
) -> tuple[_ImportOutcome, None] | tuple[None, str]:
    """Stage 1 import: parse the file and write its sidecar — nothing else.

    No Chroma, no Ollama: the file lands on disk and shows up in the source
    list immediately. Embedding is deferred to the indexing pass
    (:func:`_stream_index_pending`). Returns the outcome (always
    ``indexed=False``) or a hard error string when parsing fails.
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

    parsed.meta.index_error = ""
    parsed.meta.indexed_at = ""
    write_sidecar(files_dir, parsed.meta)
    return _ImportOutcome(
        chunk_total=0,
        indexed=False,
        already_existed=already_existed,
        has_abstract=bool(parsed.meta.abstract.strip()),
        has_categories=bool(parsed.meta.categories.strip()),
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
        "has_abstract": outcome.has_abstract,
        "has_categories": outcome.has_categories,
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

    # Announce the full resolved file list upfront — after ZIP expansion and
    # manifest discovery — so the UI can render every queued document before
    # we start processing them one by one. Without this, a Zotero ZIP appears
    # as a single row until its contents are individually unpacked.
    yield _sse({"type": "queued", "filenames": [name for name, _ in buffered]})

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
            err_msg = f"Trop volumineux (> {max_mb} Mo)"
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

        outcome, parse_err = await _import_parse_only(
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
        err = f"Trop volumineux (> {max_mb} Mo)"
        yield _sse({"type": "error", "filename": url, "error": err})
        yield _sse({"type": "done"})
        return

    file_path = files_dir / inferred_filename
    file_path.write_bytes(raw_content)

    outcome, parse_err = await _import_parse_only(
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


def _indexed_stems(project_id: str) -> set[str]:
    """Stems with at least one chunk in the project's Chroma collection.

    Returns an empty set when Chroma is unreachable (no embed provider) —
    callers then treat every file as pending and let the per-file index
    attempt surface its own error.
    """
    try:
        col = get_collection(project_id)
        result = col.get(include=["metadatas"])
    except Exception:
        return set()
    stems: set[str] = set()
    for meta in result["metadatas"] or []:
        s = meta.get("source_stem")
        if s:
            stems.add(str(s))
    return stems


async def _stream_index_pending(project_id: str, files_dir: Path) -> AsyncGenerator[str, None]:
    """Stage 2: embed every not-yet-indexed source file into Chroma.

    Iterates the project's source files, skips the ones that already have
    chunks in Chroma, and runs the full parse+embed step on the rest. Paired
    with :func:`_stream_upload`, which only saves+parses files. Re-running it
    is safe: already-indexed sources are skipped.
    """
    project_dir = files_dir.parent
    indexed = await asyncio.to_thread(_indexed_stems, project_id)
    source_files = iter_source_files(project_dir)
    pending = [f for f in source_files if Path(f.name).stem not in indexed]

    yield _sse({"type": "start_index", "total": len(pending)})
    yield _sse({"type": "queued", "filenames": [p.name for p in pending]})

    indexed_count = 0
    failed = 0

    for file_path in pending:
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
        yield _sse(_result_event(filename=filename, stem=stem, outcome=outcome))
        if outcome.indexed:
            indexed_count += 1
            ev = await _graph_update_event(project_id, filename, stem)
            if ev:
                yield ev
        else:
            failed += 1

    yield _sse({"type": "done", "total": indexed_count, "failed": failed})


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


def prune_orphan_sidecars(project_dir: Path, valid_stems: set[str]) -> list[str]:
    """Delete ``<stem>.meta.json`` sidecars whose backing document no longer
    exists on disk.

    An orphan is left behind when a delete races a concurrent metadata write
    — e.g. background auto-enrichment PATCHes a source the user removed mid
    generation, re-creating the sidecar after :func:`delete_paper` unlinked
    it. ``iter_source_files`` skips sidecars, so such files would otherwise
    never be revisited. Returns the stems pruned (for logging).
    """
    removed: list[str] = []
    for subdir in ("files", "pdfs"):
        d = project_dir / subdir
        if not d.exists():
            continue
        for f in d.iterdir():
            if not f.is_file() or not f.name.endswith(SIDECAR_SUFFIX):
                continue
            stem = f.name[: -len(SIDECAR_SUFFIX)]
            if stem in valid_stems:
                continue
            try:
                f.unlink(missing_ok=True)
                removed.append(stem)
            except OSError:
                pass
    return removed


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
    yield _sse({"type": "queued", "filenames": [p.name for p in source_files]})

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
