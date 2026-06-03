#!/usr/bin/env python
"""Gate 1 — detection des dependances circulaires (backend).

Equivalent Python de la regle `no-circular` de dependency-cruiser cote frontend.

Principe :
- on construit le graphe d'imports du paquet `app` avec grimp. grimp fait de
  l'ANALYSE STATIQUE (lecture/parsing des fichiers) : il N'EXECUTE PAS le code,
  donc le resultat est deterministe et sans effet de bord ;
- on detecte les cycles = composantes fortement connexes (CFC) non triviales du
  graphe (algorithme de Tarjan) ;
- on applique un BASELINE (mode cliquet) : seuls les cycles ABSENTS du fichier
  `import-cycles-baseline.json` font echouer la commande. Les cycles deja
  presents (dette existante) sont toleres.

Codes de sortie :
    0 = aucun NOUVEAU cycle (gate vert) ;
    1 = au moins un nouveau cycle, absent du baseline (gate rouge, bloquant) ;
    2 = un fichier .py a echappe a l'analyse (angle mort -> on bloque par securite).

Usage :
    python scripts/check_import_cycles.py                    # le gate
    python scripts/check_import_cycles.py --update-baseline  # fige l'etat courant

Les fonctions discover_packages() / expected_modules() / find_cycles() sont
parametrables et sans effet de bord, pour etre testees unitairement
(voir tests/test_check_import_cycles.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import grimp

# Le script vit dans backend/scripts/. Le paquet a analyser est backend/app/.
BACKEND_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BACKEND_DIR / "app"
BASELINE_PATH = BACKEND_DIR / "import-cycles-baseline.json"


def discover_packages(app_dir: Path = APP_DIR, backend_dir: Path = BACKEND_DIR) -> list[str]:
    """Racines a passer a grimp.

    grimp ne descend PAS tout seul dans un *namespace package* (PEP 420 : un
    dossier qui contient des .py mais PAS de __init__.py). `app/routes/` est
    exactement ce cas. On parcourt donc l'arborescence et on ajoute CHAQUE
    dossier de ce type, pour qu'AUCUN module n'echappe a l'analyse. La detection
    est DYNAMIQUE (os.walk) : elle couvre aussi les sous-paquets crees plus tard,
    sans liste codee en dur.
    """
    roots = [app_dir.name]
    for dirpath, dirnames, filenames in os.walk(app_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        has_py = any(f.endswith(".py") for f in filenames)
        has_init = "__init__.py" in filenames
        if has_py and not has_init:
            rel = Path(dirpath).relative_to(backend_dir)
            roots.append(".".join(rel.parts))
    # dedup en conservant l'ordre (au cas ou app_dir lui-meme serait un namespace).
    return list(dict.fromkeys(roots))


def expected_modules(app_dir: Path = APP_DIR, backend_dir: Path = BACKEND_DIR) -> set[str]:
    """Tous les modules attendus, deduits des fichiers .py presents sur disque.

    LIT LE DISQUE INDEPENDAMMENT de discover_packages() / grimp. Sert de FILET
    DE SECURITE : si l'analyse en oubliait un (par ex. un namespace package non
    couvert), on prefere echouer bruyamment plutot que laisser un angle mort ou
    un cycle pourrait passer inapercu.
    """
    mods: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(app_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for filename in filenames:
            if not filename.endswith(".py"):
                continue
            rel = Path(dirpath, filename).relative_to(backend_dir)
            dotted = ".".join(rel.with_suffix("").parts)
            if dotted.endswith(".__init__"):
                dotted = dotted[: -len(".__init__")]
            mods.add(dotted)
    return mods


def find_cycles(graph: grimp.ImportGraph) -> list[tuple[str, ...]]:
    """Liste des cycles = composantes fortement connexes non triviales.

    Tarjan classique. Chaque cycle est represente par le tuple TRIE de ses
    modules : cette forme canonique est une cle stable pour le baseline (l'ordre
    de parcours n'influe pas sur l'identite du cycle).
    """
    # adjacence : module -> ensemble des modules INTERNES qu'il importe direct.
    succ = {m: graph.find_modules_directly_imported_by(m) for m in graph.modules}

    index: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    counter = 0
    cycles: list[tuple[str, ...]] = []

    def strongconnect(v: str) -> None:
        nonlocal counter
        index[v] = lowlink[v] = counter
        counter += 1
        stack.append(v)
        on_stack.add(v)
        for w in sorted(succ[v]):
            if w not in index:  # voisin pas encore visite -> on descend
                strongconnect(w)
                lowlink[v] = min(lowlink[v], lowlink[w])
            elif w in on_stack:  # voisin deja dans la CFC en cours -> arete arriere
                lowlink[v] = min(lowlink[v], index[w])
        # racine d'une CFC : on depile tout le composant.
        if lowlink[v] == index[v]:
            component: list[str] = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                component.append(w)
                if w == v:
                    break
            # CFC non triviale (>1 module) OU module qui s'importe lui-meme = cycle.
            if len(component) > 1 or v in succ[v]:
                cycles.append(tuple(sorted(component)))

    for module in sorted(graph.modules):
        if module not in index:
            strongconnect(module)
    return sorted(cycles)


def load_baseline() -> set[tuple[str, ...]]:
    """Cycles connus/toleres, charges depuis le fichier baseline (vide si absent)."""
    if not BASELINE_PATH.exists():
        return set()
    data = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    return {tuple(item) for item in data}


def build_app_graph() -> grimp.ImportGraph:
    """Graphe d'imports de `app` — SOURCE UNIQUE reutilisee par les autres gates.

    Semantique RUNTIME (exclude_type_checking_imports=True) : on IGNORE les
    imports places sous `if TYPE_CHECKING:` (ils ne s'executent pas). Deux raisons :
      1) aligner la semantique sur le frontend (tsPreCompilationDeps:false =
         dependances RUNTIME uniquement) -> meme definition des deux cotes ;
      2) l'idiome standard pour casser un cycle Python est de deplacer un import
         sous `if TYPE_CHECKING:` ; sans ce flag on punirait cette bonne pratique.
    cache_dir=None : analyse toujours fraiche, aucun artefact .grimp_cache.
    sys.path : on rend `app` trouvable quel que soit le repertoire courant.
    """
    sys.path.insert(0, str(BACKEND_DIR))
    return grimp.build_graph(
        *discover_packages(),
        exclude_type_checking_imports=True,
        cache_dir=None,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Fige l'ensemble des cycles ACTUELS comme baseline tolere.",
    )
    args = parser.parse_args()

    # Tarjan est recursif (profondeur max = nb de modules) : marge de securite.
    sys.setrecursionlimit(10_000)
    graph = build_app_graph()

    # Filet de securite : aucun .py ne doit echapper au graphe analyse.
    missing = expected_modules() - graph.modules
    if missing:
        print("ERREUR : des modules .py n'ont pas ete analyses (angle mort) :", file=sys.stderr)
        for module in sorted(missing):
            print(f"  - {module}", file=sys.stderr)
        print("Corrige discover_packages() pour les couvrir.", file=sys.stderr)
        return 2

    current = set(find_cycles(graph))

    if args.update_baseline:
        ordered = [list(cycle) for cycle in sorted(current)]
        BASELINE_PATH.write_text(json.dumps(ordered, indent=2) + "\n", encoding="utf-8")
        print(f"Baseline mis a jour : {len(ordered)} cycle(s) fige(s) dans {BASELINE_PATH.name}.")
        return 0

    baseline = load_baseline()
    new_cycles = sorted(current - baseline)

    if new_cycles:
        print(f"x {len(new_cycles)} NOUVEAU(X) cycle(s) d'import detecte(s) :", file=sys.stderr)
        for cycle in new_cycles:
            print(f"  - cycle entre : {', '.join(cycle)}", file=sys.stderr)
        print(
            f"\n({len(baseline)} cycle(s) connu(s) ignore(s) via {BASELINE_PATH.name})",
            file=sys.stderr,
        )
        return 1

    print(f"OK : aucun nouveau cycle. {len(current)} cycle(s) connu(s) ignore(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
