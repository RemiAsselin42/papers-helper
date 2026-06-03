#!/usr/bin/env python
"""Gate 2 — contrats d'architecture en couches (backend).

Interdit toute dependance qui REMONTE la hierarchie (un module d'une couche
basse qui importe une couche plus haute). Meme-couche et descente sont
autorisees : c'est pourquoi le cluster mutuellement couple graph<->ingestion
(deja baseline cote cycles) tient dans UNE seule couche.

Reutilise EXACTEMENT l'infra du Gate 1 : meme graphe d'imports runtime
(check_import_cycles.build_app_graph, TYPE_CHECKING exclu), meme decouverte
dynamique des namespace packages. Baseline JSON = cliquet : les remontees
existantes sont tolerees, seules les NOUVELLES bloquent.

Codes de sortie :
    0 = aucune NOUVELLE remontee (gate vert) ;
    1 = au moins une nouvelle remontee, absente du baseline (rouge, bloquant) ;
    2 = un module n'appartient a aucune couche (zone non classee -> on bloque).

Usage :
    python scripts/check_layers.py
    python scripts/check_layers.py --update-baseline
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable

import check_import_cycles as cycles_gate

BASELINE_PATH = cycles_gate.BACKEND_DIR / "import-layers-baseline.json"

# Couches de la plus BASSE (indice 0) a la plus HAUTE. Regle : une couche ne peut
# importer QUE sa propre couche ou une couche plus basse. Chaque entree liste les
# "zones" qui la composent (sous-paquet de 1er niveau, ou module top-level).
LAYERS: list[tuple[str, set[str]]] = [
    ("L0-config", {"app", "app.config", "app.settings"}),
    (
        "L1-adapters",
        {
            "app.ollama_service",
            "app.llm_service",
            "app.embeddings",
            "app.chroma",
            "app.parsers",
        },
    ),
    ("L2-domain", {"app.ingestion", "app.graph"}),
    ("L3-web", {"app.routes"}),
    ("L4-root", {"app.main"}),
]


def area(module: str) -> str:
    """Zone d'un module = la cle servant a le rattacher a une couche.

    Les sous-paquets routes/graph/parsers sont regroupes par leur 1er niveau
    (app.routes.papers -> app.routes) ; les modules top-level gardent leur nom.
    """
    parts = module.split(".")
    if len(parts) > 1 and parts[1] in {"routes", "graph", "parsers"}:
        return f"app.{parts[1]}"
    return module


def area_rank() -> dict[str, int]:
    """zone -> indice de couche."""
    return {a: i for i, (_name, areas) in enumerate(LAYERS) for a in areas}


def rank_of(module: str, ranks: dict[str, int]) -> int | None:
    """Indice de couche d'un module, ou None si sa zone n'est dans aucune couche."""
    return ranks.get(area(module))


def unclassified_modules(graph) -> list[str]:
    """Modules dont la zone n'appartient a aucune couche (angle mort -> a classer)."""
    ranks = area_rank()
    return sorted(m for m in graph.modules if rank_of(m, ranks) is None)


def find_upward_edges(graph, rank: Callable[[str], int | None]) -> list[tuple[str, str]]:
    """Aretes qui REMONTENT : importateur d'une couche plus basse que l'importe.

    `rank` est un callable module -> indice de couche (ou None). Parametre pour
    pouvoir tester l'algorithme sur des graphes jouets.
    """
    out: list[tuple[str, str]] = []
    for module in sorted(graph.modules):
        r_from = rank(module)
        if r_from is None:
            continue
        for imported in sorted(graph.find_modules_directly_imported_by(module)):
            r_to = rank(imported)
            if r_to is not None and r_from < r_to:
                out.append((module, imported))
    return sorted(out)


def load_baseline() -> set[tuple[str, str]]:
    """Remontees connues/tolerees, depuis le fichier baseline (vide si absent)."""
    if not BASELINE_PATH.exists():
        return set()
    data = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    return {tuple(item) for item in data}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Fige les remontees ACTUELLES comme baseline tolere.",
    )
    args = parser.parse_args()

    graph = cycles_gate.build_app_graph()

    unknown = unclassified_modules(graph)
    if unknown:
        print("ERREUR : module(s) sans couche (a classer dans LAYERS) :", file=sys.stderr)
        for module in unknown:
            print(f"  - {module}", file=sys.stderr)
        return 2

    ranks = area_rank()
    current = set(find_upward_edges(graph, lambda m: rank_of(m, ranks)))

    if args.update_baseline:
        ordered = [list(edge) for edge in sorted(current)]
        BASELINE_PATH.write_text(json.dumps(ordered, indent=2) + "\n", encoding="utf-8")
        print(f"Baseline mis a jour : {len(ordered)} remontee(s) dans {BASELINE_PATH.name}.")
        return 0

    baseline = load_baseline()
    new_edges = sorted(current - baseline)

    if new_edges:
        print(f"x {len(new_edges)} NOUVELLE(S) remontee(s) detectee(s) :", file=sys.stderr)
        for importer, imported in new_edges:
            lo, hi = rank_of(importer, ranks), rank_of(imported, ranks)
            print(f"  - L{lo} {importer}  ->  L{hi} {imported}", file=sys.stderr)
        known = f"\n({len(baseline)} remontee(s) connue(s) ignoree(s) via {BASELINE_PATH.name})"
        print(known, file=sys.stderr)
        return 1

    print(f"OK : aucune nouvelle remontee. {len(current)} remontee(s) connue(s) ignoree(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
