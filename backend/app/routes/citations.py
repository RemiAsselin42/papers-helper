"""HTTP surface for citation search — semantic search over the project's
indexed chunks.

- `POST /projects/{id}/citations/search`  → ranked text snippets matching a
                                             free-text query (vector search).
- `GET  /projects/{id}/citations/context` → the window of chunks around a hit,
                                             for "show more context".
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.chroma import get_collection
from app.config import PROJECTS_DIR
from app.routes.papers import ChunkInfo

router = APIRouter(prefix="/projects/{project_id}/citations", tags=["citations"])

_DEFAULT_LIMIT = 20
# Upper bound on a single response. Generous so the client's incremental
# "load more" (page size 20) can keep widening the request.
_MAX_LIMIT = 200
_DEFAULT_RADIUS = 2
_MAX_RADIUS = 5
# Quality floor on returned hits (normal mode only): drop snippets too short
# to be a usable citation, and hits only weakly related to the query. Strict
# mode skips these — it is a lexical search refined client-side by exact
# phrase, so a low semantic score is not a reason to drop a real match.
_MIN_CHUNK_WORDS = 8
_MIN_SIMILARITY = 0.05
# Vector candidates fetched per search = limit × this. Over-fetching leaves
# enough rows after the post-filters trim; strict mode fetches wider so the
# phrase-bearing chunk is in the candidate set even when it scores modestly.
_OVER_FETCH = 4
_STRICT_OVER_FETCH = 8


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class CitationSearchRequest(BaseModel):
    query: str
    limit: int = Field(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT)
    # Strict (exact-phrase) mode — relaxes the quality floors, see below.
    strict: bool = False
    # Optional metadata filters — null means "no filter on this field".
    stem: str | None = None
    author: str | None = None
    category: str | None = None


class CitationHit(BaseModel):
    chunk_id: str
    text: str
    chunk_index: int
    chunk_total: int
    similarity: float  # 1.0 - distance, clamped to [0, 1]
    stem: str
    filename: str
    title: str
    author: str
    year: str


class CitationSearchResponse(BaseModel):
    query: str
    results: list[CitationHit]


class CitationContextResponse(BaseModel):
    stem: str
    chunks: list[ChunkInfo]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _check_project_exists(project_id: str) -> None:
    if not (PROJECTS_DIR / project_id).exists():
        raise HTTPException(status_code=404, detail="Project not found")


def _first_row(value: Any) -> list[Any]:
    """`collection.query()` nests one list per query_text — we only ever pass
    a single query, so the meaningful payload is always row 0."""
    rows = value or [[]]
    return list(rows[0] or [])


def _meta_str(meta: dict[str, Any], key: str) -> str:
    val = meta.get(key)
    return str(val) if val not in (None, "") else ""


def _meta_int(meta: dict[str, Any], key: str) -> int:
    try:
        return int(meta.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _category_match(meta: dict[str, Any], category: str) -> bool:
    raw = str(meta.get("categories") or "")
    cats = {c.strip().lower() for c in raw.split(",") if c.strip()}
    return category.strip().lower() in cats


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/search", response_model=CitationSearchResponse)
async def search_citations(project_id: str, body: CitationSearchRequest) -> CitationSearchResponse:
    """Run a semantic vector search over the project's indexed chunks and
    return the closest text snippets, ranked by similarity."""
    _check_project_exists(project_id)
    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="La requête de recherche est vide.")

    def _search() -> list[CitationHit]:
        collection = get_collection(project_id)
        count = collection.count()
        if count == 0:
            return []

        # Exact-match filters that Chroma can evaluate go to the DB; the
        # category filter is post-applied in Python (CSV metadata).
        conditions: list[dict[str, Any]] = []
        if body.stem:
            conditions.append({"source_stem": body.stem})
        if body.author:
            conditions.append({"author": body.author})
        where: dict[str, Any] | None = None
        if len(conditions) == 1:
            where = conditions[0]
        elif len(conditions) > 1:
            where = {"$and": conditions}

        over_fetch = _STRICT_OVER_FETCH if body.strict else _OVER_FETCH
        n_results = min(body.limit * over_fetch, count)
        # The category filter can't be pushed to Chroma — it lives inside a
        # CSV `categories` metadata string — so it is applied in Python after
        # the query. A fixed over-fetch could then under-fill the response
        # when most candidates miss the category, so rank the whole collection
        # for a category search and let the post-filter trim it. Bounded: one
        # local project's chunk count.
        if body.category:
            n_results = count

        qres = collection.query(
            query_texts=[query],
            n_results=n_results,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        ids = _first_row(qres.get("ids"))
        docs = _first_row(qres.get("documents"))
        metas = _first_row(qres.get("metadatas"))
        dists = _first_row(qres.get("distances"))

        hits: list[CitationHit] = []
        for cid, doc, meta, dist in zip(ids, docs, metas, dists, strict=False):
            if not doc:
                continue
            meta_d = dict(meta) if meta else {}
            if body.category and not _category_match(meta_d, body.category):
                continue
            similarity = max(0.0, min(1.0, 1.0 - float(dist)))
            # Quality floors apply in normal mode only. Strict mode is lexical
            # — the client keeps only chunks carrying the exact phrase, so a
            # short or low-scoring chunk that does carry it must survive here.
            if not body.strict:
                # Skip fragments too short to cite (e.g. a stray "web." chunk).
                words = _meta_int(meta_d, "word_count") or len(str(doc).split())
                if words < _MIN_CHUNK_WORDS:
                    continue
                # Skip hits only weakly related to the query.
                if similarity < _MIN_SIMILARITY:
                    continue
            hits.append(
                CitationHit(
                    chunk_id=str(cid),
                    text=str(doc),
                    chunk_index=_meta_int(meta_d, "chunk_index"),
                    chunk_total=_meta_int(meta_d, "chunk_total"),
                    similarity=similarity,
                    stem=_meta_str(meta_d, "source_stem"),
                    filename=_meta_str(meta_d, "source_filename"),
                    title=_meta_str(meta_d, "pdf_title"),
                    author=_meta_str(meta_d, "author"),
                    year=_meta_str(meta_d, "year"),
                )
            )
            if len(hits) >= body.limit:
                break
        return hits

    results = await asyncio.to_thread(_search)
    return CitationSearchResponse(query=query, results=results)


@router.get("/context", response_model=CitationContextResponse)
async def get_citation_context(
    project_id: str,
    stem: str = Query(...),
    chunk_index: int = Query(..., ge=0),
    radius: int = Query(default=_DEFAULT_RADIUS, ge=1, le=_MAX_RADIUS),
) -> CitationContextResponse:
    """Return the window of chunks `[chunk_index - radius, chunk_index + radius]`
    for a single source — the backing data for the "show more context" button.

    Targeted on purpose: a single `.get()` for ~5 chunks, rather than loading
    every chunk of a long document via `GET /papers/{stem}/chunks`."""
    _check_project_exists(project_id)

    def _fetch() -> list[ChunkInfo]:
        collection = get_collection(project_id)
        lo = max(0, chunk_index - radius)
        wanted: list[str | int | float | bool] = list(range(lo, chunk_index + radius + 1))
        # Nested $and / $in shape — Chroma accepts it verbatim at runtime even
        # though it doesn't fit its strict Where TypedDict.
        where: dict[str, Any] = {"$and": [{"source_stem": stem}, {"chunk_index": {"$in": wanted}}]}
        res = collection.get(where=where, include=["documents", "metadatas"])
        chunks: list[ChunkInfo] = []
        for cid, doc, meta in zip(
            res.get("ids") or [],
            res.get("documents") or [],
            res.get("metadatas") or [],
            strict=False,
        ):
            meta_d = dict(meta) if meta else {}
            chunks.append(
                ChunkInfo(
                    id=str(cid),
                    chunk_index=_meta_int(meta_d, "chunk_index"),
                    word_count=_meta_int(meta_d, "word_count"),
                    text=str(doc or ""),
                )
            )
        return sorted(chunks, key=lambda c: c.chunk_index)

    chunks = await asyncio.to_thread(_fetch)
    return CitationContextResponse(stem=stem, chunks=chunks)
