"""Context-injection helpers for the chat endpoint.

Three independent sources of context are assembled here, each as a system
message that the route handler then inserts ahead of the user/assistant
exchange:

- problematique: per-project research framing
- mention RAG: per-source retrieval (full doc for short, top-k+neighbors for long)
- global RAG: whole-corpus semantic search (opt-in)

The route handler in `routes.py` decides which to apply per request; this
module is concerned only with how to build each block.
"""

from __future__ import annotations

import json
from typing import Any

from app.chroma import get_collection
from app.config import (
    CHAT_GLOBAL_RAG_K,
    CHAT_K_PER_MENTION,
    CHAT_MENTION_CONTENT_CHAR_CAP,
    CHAT_MENTION_TOTAL_CHAR_CAP,
)
from app.routes.projects import read_problematique_sync

# Below this chunk count a mentioned source is sent in full; above, top-k
# semantic retrieval kicks in.
SHORT_DOC_CHUNK_THRESHOLD = 10


def _chunk_idx(meta: dict[str, Any]) -> int:
    try:
        return int(meta.get("chunk_index", 0))
    except (TypeError, ValueError):
        return 0


def _format_problematique_context(project_id: str) -> str | None:
    """Render the project's problematique as a Markdown system message in
    French. Returns None when the problematique is absent or wholly empty so
    the chat handler can skip injecting noise for projects that haven't
    filled it in."""
    try:
        problem = read_problematique_sync(project_id)
    except (OSError, json.JSONDecodeError):
        return None

    nonempty_hyp = [
        h
        for h in problem.hypotheses
        if h.text.strip() or any(s.strip() for s in h.sub_hypotheses)
    ]
    nonempty_app = [
        a for a in problem.planned_approaches if a.title.strip() or a.text.strip()
    ]
    has_content = bool(
        problem.research_problem.strip()
        or problem.sub_research_problem.strip()
        or nonempty_hyp
        or nonempty_app
        or problem.expected_outcomes.strip()
    )
    if not has_content:
        return None

    parts: list[str] = [
        "Contexte du projet de recherche. Utilisez ces informations pour cadrer "
        "vos réponses (ne les répétez pas verbatim sauf si on vous le demande)."
    ]

    if problem.research_problem.strip():
        parts.append(f"## Problème de recherche\n{problem.research_problem.strip()}")
    if problem.sub_research_problem.strip():
        parts.append(f"## Sous-problème\n{problem.sub_research_problem.strip()}")

    if nonempty_hyp:
        lines: list[str] = ["## Hypothèses"]
        for i, h in enumerate(nonempty_hyp, 1):
            text = h.text.strip()
            lines.append(f"{i}. {text}" if text else f"{i}.")
            for sub in h.sub_hypotheses:
                if sub.strip():
                    lines.append(f"   - {sub.strip()}")
        parts.append("\n".join(lines))

    if nonempty_app:
        lines = ["## Approches envisagées"]
        for a in nonempty_app:
            if a.title.strip():
                lines.append(f"### {a.title.strip()}")
            if a.text.strip():
                lines.append(a.text.strip())
        parts.append("\n".join(lines))

    if problem.expected_outcomes.strip():
        parts.append(f"## Résultats attendus\n{problem.expected_outcomes.strip()}")

    return "\n\n".join(parts)


def _truncate_body(body: str) -> str:
    if len(body) > CHAT_MENTION_CONTENT_CHAR_CAP:
        return body[:CHAT_MENTION_CONTENT_CHAR_CAP] + "\n…[contenu tronqué]"
    return body


def _rows_to_body(
    documents: list[Any], metadatas: list[Any]
) -> str:
    rows: list[tuple[Any, dict[str, Any]]] = []
    for doc, meta in zip(documents, metadatas, strict=False):
        if not doc:
            continue
        rows.append((doc, dict(meta) if meta else {}))
    rows.sort(key=lambda r: _chunk_idx(r[1]))
    body = "\n\n".join(doc for doc, _meta in rows).strip()
    return _truncate_body(body)


def _fetch_full_stem(collection: Any, stem: str) -> str:
    res = collection.get(
        where={"source_stem": stem},
        include=["documents", "metadatas"],
    )
    return _rows_to_body(res.get("documents") or [], res.get("metadatas") or [])


def _fetch_topk_stem(
    collection: Any, stem: str, query: str, include_neighbors: bool
) -> str:
    qres = collection.query(
        query_texts=[query],
        n_results=CHAT_K_PER_MENTION,
        where={"source_stem": stem},
        include=["documents", "metadatas"],
    )
    # query() nests one list per query_text; we passed a single query.
    hit_docs_raw = (qres.get("documents") or [[]])[0]
    hit_metas_raw = (qres.get("metadatas") or [[]])[0]
    hit_docs: list[Any] = list(hit_docs_raw or [])
    hit_metas: list[Any] = list(hit_metas_raw or [])

    if not include_neighbors:
        return _rows_to_body(hit_docs, hit_metas)

    hit_indices: set[int] = set()
    for meta in hit_metas:
        if meta:
            hit_indices.add(_chunk_idx(dict(meta)))
    if not hit_indices:
        return _rows_to_body(hit_docs, hit_metas)

    wanted: set[int] = set()
    for idx in hit_indices:
        wanted.add(idx)
        if idx > 0:
            wanted.add(idx - 1)
        wanted.add(idx + 1)

    in_idx: list[str | int | float | bool] = list(wanted)
    # mypy can't fit the nested $and / $in shape into Chroma's strict Where
    # TypedDict — runtime accepts this verbatim.
    where_clause: dict[str, Any] = {
        "$and": [{"source_stem": stem}, {"chunk_index": {"$in": in_idx}}]
    }
    nres = collection.get(
        where=where_clause,
        include=["documents", "metadatas"],
    )
    return _rows_to_body(nres.get("documents") or [], nres.get("metadatas") or [])


def _retrieve_mention_context(
    project_id: str,
    stems: list[str],
    query: str | None,
    include_neighbors: bool,
) -> str | None:
    """Build a system message summarising the mentioned sources. Short docs
    (≤ SHORT_DOC_CHUNK_THRESHOLD chunks) are sent in full; longer ones go
    through a semantic top-k query against the last user message, optionally
    expanded with adjacent chunks for reading continuity.

    Returns None when no chunk could be assembled.
    """
    if not stems:
        return None
    collection = get_collection(project_id)

    # Pass 1: lightweight chunk count per stem to decide full-doc vs top-k.
    # We need the metadata anyway to format the section header (filename,
    # source type) — without it we'd have to issue a second .get() just for
    # display info.
    in_values: list[str | int | float | bool] = list(stems)
    # Chroma's `Where` is a strict TypedDict union; mypy needs help inferring
    # both the literal "$in" key and the widened element type of the values.
    initial_where: dict[str, Any] = {"source_stem": {"$in": in_values}}
    initial = collection.get(
        where=initial_where,
        include=["metadatas"],
    )
    initial_metas = initial.get("metadatas") or []

    counts: dict[str, int] = {s: 0 for s in stems}
    first_meta: dict[str, dict[str, Any]] = {}
    for meta in initial_metas:
        if not meta:
            continue
        meta_d = dict(meta)
        stem = str(meta_d.get("source_stem") or "")
        if stem in counts:
            counts[stem] += 1
            if stem not in first_meta:
                first_meta[stem] = meta_d

    sections: list[str] = []
    for stem in stems:
        n = counts.get(stem, 0)
        if n == 0:
            continue
        # Short docs always go through .get(); long docs need a query string
        # to drive semantic retrieval — without one we fall back to full doc
        # (and let the per-source cap truncate).
        use_topk = n > SHORT_DOC_CHUNK_THRESHOLD and bool(query)
        body = (
            _fetch_topk_stem(collection, stem, query or "", include_neighbors)
            if use_topk
            else _fetch_full_stem(collection, stem)
        )
        if not body:
            continue
        meta = first_meta.get(stem, {})
        filename = str(meta.get("source_filename") or stem)
        source_type = str(meta.get("source_type") or "document").capitalize()
        sections.append(
            f"═══ DÉBUT DU CONTENU : {filename} ({source_type}) ═══\n"
            f"{body}\n"
            f"═══ FIN DU CONTENU : {filename} ═══"
        )

    if not sections:
        return None

    header = (
        "Le contenu (intégral ou extraits pertinents) des documents mentionnés "
        "par l'utilisateur est inclus ci-dessous, directement dans ton contexte. "
        "Tu y as un accès direct et complet. N'écris JAMAIS que tu ne peux pas "
        "accéder à un fichier mentionné, que tu n'as pas reçu de pièce jointe, "
        "ou que tu ne peux pas lire de PDF : leur texte est forcément présent "
        "dans les blocs DÉBUT/FIN DU CONTENU ci-dessous. Appuie-toi sur ce "
        "contenu pour répondre."
    )

    # Boundary-aware accumulation: drop trailing sections rather than splitting
    # one mid-byte. Guarantees at least the first section is included even if
    # it alone exceeds the total cap (capped per-source above to 20k).
    selected: list[str] = []
    used = 0
    truncated = False
    for sec in sections:
        sep = 2 if selected else 0
        if selected and used + sep + len(sec) > CHAT_MENTION_TOTAL_CHAR_CAP:
            truncated = True
            break
        selected.append(sec)
        used += sep + len(sec)
    joined = "\n\n".join(selected)
    if truncated:
        joined += "\n…[contexte mentionné tronqué]"
    return f"{header}\n\n{joined}"


def _retrieve_global_context(project_id: str, query: str) -> str | None:
    """Run a semantic search across the entire project collection. Returns
    None when the project has no embedded content or the query is empty."""
    if not query.strip():
        return None
    collection = get_collection(project_id)
    qres = collection.query(
        query_texts=[query],
        n_results=CHAT_GLOBAL_RAG_K,
        include=["documents", "metadatas"],
    )
    docs_raw = (qres.get("documents") or [[]])[0]
    metas_raw = (qres.get("metadatas") or [[]])[0]
    docs: list[Any] = list(docs_raw or [])
    metas: list[Any] = list(metas_raw or [])

    sections: list[str] = []
    for doc, meta in zip(docs, metas, strict=False):
        if not doc:
            continue
        meta_d = dict(meta) if meta else {}
        fname = str(meta_d.get("source_filename") or meta_d.get("source_stem") or "?")
        idx = _chunk_idx(meta_d)
        total = meta_d.get("chunk_total")
        loc = f"chunk {idx}/{total}" if total else f"chunk {idx}"
        sections.append(f"--- {fname} ({loc}) ---\n{doc}")

    if not sections:
        return None

    header = (
        "Extraits potentiellement pertinents du corpus du projet, trouvés par "
        "recherche sémantique automatique. À utiliser comme références "
        "complémentaires, pas comme source unique."
    )
    return f"{header}\n\n" + "\n\n".join(sections)


__all__ = [
    "SHORT_DOC_CHUNK_THRESHOLD",
    "_format_problematique_context",
    "_retrieve_global_context",
    "_retrieve_mention_context",
]
