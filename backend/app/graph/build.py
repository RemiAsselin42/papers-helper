"""Pure functions that derive nodes and edges from a sidecar entry.

Kept separate from I/O so tests can exercise the derivation logic without
touching Chroma or the filesystem.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from app.graph.schema import (
    Graph,
    GraphEdge,
    GraphNode,
    author_node_id,
    category_node_id,
    concept_node_id,
    paper_node_id,
    slug_author,
)

if TYPE_CHECKING:
    # Imported only for typing — at runtime we rely on attribute access, which
    # lets us avoid a cycle: app.ingestion imports app.graph (for hooks), and
    # app.graph.build would otherwise import back into app.ingestion.
    from app.ingestion import SidecarMeta


def split_categories(categories: str) -> list[str]:
    """Split a user-entered `categories` string into individual labels.

    Tolerant: accepts both `,` and `;` as separators, trims whitespace, drops
    empties, deduplicates case-insensitively (preserving first-seen casing for
    the label).
    """
    if not categories:
        return []
    pieces = [p.strip() for raw in categories.split(";") for p in raw.split(",")]
    seen: dict[str, str] = {}
    for p in pieces:
        if not p:
            continue
        key = p.lower()
        if key not in seen:
            seen[key] = p
    return list(seen.values())


def parse_authors(meta: SidecarMeta) -> list[dict[str, str]]:
    """Pull the structured authors list out of the sidecar.

    Falls back to splitting the flat `author` string on " ; " when
    `authors_json` is unset (legacy sidecars).
    """
    if meta.authors_json:
        try:
            raw = json.loads(meta.authors_json)
        except json.JSONDecodeError:
            raw = []
        if isinstance(raw, list):
            out: list[dict[str, str]] = []
            for entry in raw:
                if not isinstance(entry, dict):
                    continue
                family = str(entry.get("family", "")).strip()
                given = str(entry.get("given", "")).strip()
                if family or given:
                    out.append({"family": family, "given": given})
            if out:
                return out

    if meta.author:
        out_legacy: list[dict[str, str]] = []
        for piece in meta.author.split(";"):
            piece = piece.strip()
            if not piece:
                continue
            if "," in piece:
                family, given = piece.split(",", 1)
                out_legacy.append({"family": family.strip(), "given": given.strip()})
            else:
                out_legacy.append({"family": piece, "given": ""})
        return out_legacy

    return []


def parse_concepts_json(concepts_json: str) -> list[str]:
    if not concepts_json:
        return []
    try:
        raw = json.loads(concepts_json)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for entry in raw:
        if isinstance(entry, str):
            s = entry.strip()
            if s:
                out.append(s)
    return out


def paper_node_for(meta: SidecarMeta) -> GraphNode:
    label = (meta.pdf_title or meta.filename or meta.stem).strip() or meta.stem
    return GraphNode(
        id=paper_node_id(meta.stem),
        type="paper",
        label=label,
        data={
            "stem": meta.stem,
            "filename": meta.filename,
            "year": meta.year,
            "author": meta.author,
            "source_type": meta.source_type,
            "doi": meta.doi,
            "publication": meta.publication,
        },
    )


def author_nodes_and_edges_for(
    paper_id: str, authors: list[dict[str, str]]
) -> tuple[list[GraphNode], list[GraphEdge]]:
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    seen: set[str] = set()
    for author in authors:
        family = author.get("family", "").strip()
        given = author.get("given", "").strip()
        node_id = author_node_id(family, given)
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        label = f"{family}, {given}".rstrip(", ").strip() or family or given
        nodes.append(
            GraphNode(
                id=node_id,
                type="author",
                label=label,
                data={"aliases": [{"family": family, "given": given}], "paper_count": 1},
            )
        )
        edges.append(GraphEdge(source=paper_id, target=node_id, type="authored_by"))
    return nodes, edges


def category_nodes_and_edges_for(
    paper_id: str, categories: list[str]
) -> tuple[list[GraphNode], list[GraphEdge]]:
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    seen: set[str] = set()
    for cat in categories:
        node_id = category_node_id(cat)
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        nodes.append(GraphNode(id=node_id, type="category", label=cat, data={"paper_count": 1}))
        edges.append(GraphEdge(source=paper_id, target=node_id, type="category_of"))
    return nodes, edges


def concept_nodes_and_edges_for(
    paper_id: str, concepts: list[str]
) -> tuple[list[GraphNode], list[GraphEdge]]:
    nodes: list[GraphNode] = []
    edges: list[GraphEdge] = []
    seen: set[str] = set()
    for c in concepts:
        node_id = concept_node_id(c)
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        nodes.append(GraphNode(id=node_id, type="concept", label=c, data={"paper_count": 1}))
        edges.append(GraphEdge(source=paper_id, target=node_id, type="concept_of"))
    return nodes, edges


# ---------------------------------------------------------------------------
# Merge helpers — operate on a Graph in place. Idempotent: re-adding the same
# paper produces the same result.
# ---------------------------------------------------------------------------


def _index_by_id(nodes: list[GraphNode]) -> dict[str, GraphNode]:
    return {n.id: n for n in nodes}


def _merge_alias(node: GraphNode, alias: dict[str, str]) -> None:
    aliases = node.data.setdefault("aliases", [])
    if not isinstance(aliases, list):
        node.data["aliases"] = [alias]
        return
    for existing in aliases:
        if (
            isinstance(existing, dict)
            and existing.get("family") == alias.get("family")
            and existing.get("given") == alias.get("given")
        ):
            return
    aliases.append(alias)


def _strip_paper_contributions(graph: Graph, paper_id: str) -> None:
    """Drop the paper node + every incident edge. Does NOT recompute
    co_authored or prune orphans — used by `merge_paper` which does that step
    once after all merges are applied."""
    graph.edges = [e for e in graph.edges if e.source != paper_id and e.target != paper_id]
    graph.nodes = [n for n in graph.nodes if n.id != paper_id]


def remove_paper(graph: Graph, paper_id: str) -> None:
    """Public removal: drop the paper, recompute co_authored from what's left,
    and prune orphaned auxiliary nodes."""
    _strip_paper_contributions(graph, paper_id)
    merge_fuzzy_authors(graph)
    _dedup_edges(graph)
    _recompute_co_authored(graph)
    _prune_orphans(graph)


def _prune_orphans(graph: Graph) -> None:
    """Drop author/category/concept nodes that have no incident edges left.
    Paper nodes are never auto-pruned — only `remove_paper` removes them."""
    referenced: set[str] = set()
    for edge in graph.edges:
        referenced.add(edge.source)
        referenced.add(edge.target)
    graph.nodes = [n for n in graph.nodes if n.type == "paper" or n.id in referenced]
    # Rebuild paper_count metadata from incident edges so the UI can size nodes.
    counts: dict[str, int] = {}
    for edge in graph.edges:
        if edge.type in ("authored_by", "category_of", "concept_of"):
            counts[edge.target] = counts.get(edge.target, 0) + 1
    for node in graph.nodes:
        if node.type in ("author", "category", "concept"):
            node.data["paper_count"] = counts.get(node.id, 0)


def _recompute_co_authored(graph: Graph) -> None:
    """Drop existing co_authored edges and re-derive from current authored_by
    relations. Weight = number of shared papers.

    Called after every paper add/remove/update; the input set is small enough
    (~hundreds of authors) that a full recompute is cheaper than incremental
    bookkeeping that drifts.
    """
    graph.edges = [e for e in graph.edges if e.type != "co_authored"]
    authored: dict[str, set[str]] = {}
    for edge in graph.edges:
        if edge.type == "authored_by":
            authored.setdefault(edge.source, set()).add(edge.target)

    pair_counts: dict[tuple[str, str], int] = {}
    for paper_id, authors in authored.items():
        if len(authors) < 2:
            continue
        sorted_authors = sorted(authors)
        for i in range(len(sorted_authors)):
            for j in range(i + 1, len(sorted_authors)):
                key = (sorted_authors[i], sorted_authors[j])
                pair_counts[key] = pair_counts.get(key, 0) + 1

    for (a, b), count in pair_counts.items():
        graph.edges.append(GraphEdge(source=a, target=b, type="co_authored", weight=float(count)))


# ---------------------------------------------------------------------------
# Fuzzy author de-duplication
# ---------------------------------------------------------------------------


def _author_is_bare(node: GraphNode) -> bool:
    """True iff every alias on this author node lacks a given name — i.e. the
    author was only ever cited as a bare family name ("Smith", never
    "Smith, J."). Such a node slugs to `author:<family>` with no initial."""
    aliases = node.data.get("aliases")
    if not isinstance(aliases, list) or not aliases:
        return False
    return all(isinstance(a, dict) and not str(a.get("given", "")).strip() for a in aliases)


def _author_family_key(node: GraphNode) -> str:
    """Family-name slug shared by every spelling of an author. Both the bare
    `author:smith` node and the initialled `author:smith_j` node resolve to
    the same key, so the dedup pass can group them together."""
    aliases = node.data.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            if isinstance(alias, dict):
                family = slug_author(str(alias.get("family", "")), "")
                if family:
                    return family
    # Fallback for nodes without aliases: use the raw id.
    return node.id[len("author:") :] if node.id.startswith("author:") else node.id


def merge_fuzzy_authors(graph: Graph) -> int:
    """Merge each bare-family author node into its initialled sibling.

    The slug `family_initial` already collapses "Smith, J." and "Smith, John"
    into one node — what it cannot collapse is an author cited *without* a
    given name: "Smith" slugs to `author:smith`, "Smith, J." to
    `author:smith_j`. This pass folds the bare node into the initialled one.

    Conservative on purpose: a bare node is only merged when its family has
    *exactly one* initialled candidate. With several ("Smith, J." vs
    "Smith, K." next to a bare "Smith") the right target is unknowable, so the
    bare node is left standing rather than guessing.

    Rewires `authored_by` edges onto the survivor and folds the bare node's
    aliases into it. `co_authored` is recomputed downstream from the rewired
    `authored_by` set, so it needs no special handling here. Returns the
    number of nodes merged away. Idempotent.
    """
    authors = [n for n in graph.nodes if n.type == "author"]
    groups: dict[str, list[GraphNode]] = {}
    for node in authors:
        groups.setdefault(_author_family_key(node), []).append(node)

    redirects: dict[str, str] = {}
    for group in groups.values():
        if len(group) < 2:
            continue
        bare = [n for n in group if _author_is_bare(n)]
        named = [n for n in group if not _author_is_bare(n)]
        if len(named) != 1 or not bare:
            continue
        target = named[0]
        for node in bare:
            if node.id == target.id or node.id in redirects:
                continue
            redirects[node.id] = target.id
            for alias in node.data.get("aliases") or []:
                if isinstance(alias, dict):
                    _merge_alias(target, alias)

    if not redirects:
        return 0

    graph.nodes = [n for n in graph.nodes if n.id not in redirects]
    for edge in graph.edges:
        if edge.source in redirects:
            edge.source = redirects[edge.source]
        if edge.target in redirects:
            edge.target = redirects[edge.target]
    return len(redirects)


def _dedup_edges(graph: Graph) -> None:
    """Collapse duplicate `(source, target, type)` edges, keeping the max
    weight. The fuzzy author merge can create these when one paper credited
    the same author under two spellings. `co_authored` / `semantic` are left
    untouched — they are recomputed / canonicalised by their own passes."""
    seen: dict[tuple[str, str, str], GraphEdge] = {}
    out: list[GraphEdge] = []
    for edge in graph.edges:
        if edge.type in ("co_authored", "semantic"):
            out.append(edge)
            continue
        key = (edge.source, edge.target, edge.type)
        prev = seen.get(key)
        if prev is None:
            seen[key] = edge
            out.append(edge)
        elif edge.weight > prev.weight:
            prev.weight = edge.weight
    graph.edges = out


def _canonical_semantic(a: str, b: str) -> tuple[str, str]:
    """Order endpoints so `(min, max)` keys are stable for undirected semantic
    edges and we can dedupe across multiple paper adds."""
    return (a, b) if a <= b else (b, a)


def merge_paper(
    graph: Graph,
    paper: GraphNode,
    aux_nodes: list[GraphNode],
    aux_edges: list[GraphEdge],
    semantic_edges: list[GraphEdge],
) -> None:
    """Merge a paper, its auxiliary nodes/edges, and its semantic edges into
    *graph* in place. Existing nodes/edges for the same paper are replaced.

    Order:
    1. Remove any previous incarnation of the paper (and orphaned aux nodes).
    2. Add paper node + aux nodes (merging aliases / accumulating data on
       existing aux nodes).
    3. Add authored_by / category_of / concept_of edges.
    4. Add semantic edges, canonicalised so (a,b) and (b,a) collapse; keep the
       max observed weight when an edge already exists from another paper's
       point of view.
    5. Fuzzy-merge bare-family author nodes into their initialled sibling,
       then collapse any duplicate edges the rewire produced.
    6. Recompute co_authored from scratch.
    7. Prune orphans.

    Steps 5-7 each scan the whole graph, so a batch ingest of N papers is
    O(N) full-graph passes — `rebuild` adds papers one at a time. Fine at V1
    scale (<1000 papers, same ceiling as the whole-graph GET in queries.py);
    revisit with a batch mode if that ceiling is lifted.
    """
    _strip_paper_contributions(graph, paper.id)
    graph.nodes.append(paper)
    nodes_by_id = _index_by_id(graph.nodes)
    for node in aux_nodes:
        existing = nodes_by_id.get(node.id)
        if existing is None:
            graph.nodes.append(node)
            nodes_by_id[node.id] = node
            continue
        # Merge data: aliases dedup, label keeps the existing one
        if node.type == "author":
            aliases = node.data.get("aliases") or []
            if isinstance(aliases, list):
                for alias in aliases:
                    if isinstance(alias, dict):
                        _merge_alias(existing, alias)
    graph.edges.extend(aux_edges)

    # Semantic edges: dedupe by canonical (source, target); keep max weight.
    existing_sem: dict[tuple[str, str], GraphEdge] = {}
    remaining: list[GraphEdge] = []
    for e in graph.edges:
        if e.type != "semantic":
            remaining.append(e)
            continue
        key = _canonical_semantic(e.source, e.target)
        prev = existing_sem.get(key)
        if prev is None or e.weight > prev.weight:
            existing_sem[key] = GraphEdge(
                source=key[0], target=key[1], type="semantic", weight=e.weight
            )
    for e in semantic_edges:
        if e.source == e.target:
            continue
        key = _canonical_semantic(e.source, e.target)
        prev = existing_sem.get(key)
        if prev is None or e.weight > prev.weight:
            existing_sem[key] = GraphEdge(
                source=key[0], target=key[1], type="semantic", weight=e.weight
            )
    graph.edges = remaining + list(existing_sem.values())

    merge_fuzzy_authors(graph)
    _dedup_edges(graph)
    _recompute_co_authored(graph)
    _prune_orphans(graph)


def derive_paper_contribution(
    meta: SidecarMeta,
    concepts: list[str],
) -> tuple[GraphNode, list[GraphNode], list[GraphEdge]]:
    """Single entry point that builds a paper's nodes and (non-semantic) edges.

    Returns: (paper_node, aux_nodes, aux_edges).
    Semantic edges are computed separately by the orchestrator since they need
    Chroma access.
    """
    paper = paper_node_for(meta)
    aux_nodes: list[GraphNode] = []
    aux_edges: list[GraphEdge] = []

    authors = parse_authors(meta)
    author_nodes, authored_by_edges = author_nodes_and_edges_for(paper.id, authors)
    aux_nodes.extend(author_nodes)
    aux_edges.extend(authored_by_edges)

    categories = split_categories(meta.categories)
    category_nodes, category_edges = category_nodes_and_edges_for(paper.id, categories)
    aux_nodes.extend(category_nodes)
    aux_edges.extend(category_edges)

    concept_nodes, concept_edges = concept_nodes_and_edges_for(paper.id, concepts)
    aux_nodes.extend(concept_nodes)
    aux_edges.extend(concept_edges)

    return paper, aux_nodes, aux_edges


def graph_stats(graph: Graph) -> dict[str, Any]:
    """Aggregate counts per node/edge type for UI badges and tests."""
    node_counts: dict[str, int] = {}
    for n in graph.nodes:
        node_counts[n.type] = node_counts.get(n.type, 0) + 1
    edge_counts: dict[str, int] = {}
    for e in graph.edges:
        edge_counts[e.type] = edge_counts.get(e.type, 0) + 1
    return {
        "nodes": node_counts,
        "edges": edge_counts,
        "node_total": len(graph.nodes),
        "edge_total": len(graph.edges),
    }
