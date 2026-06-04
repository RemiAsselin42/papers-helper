#!/usr/bin/env python
"""Gate 3 — cliquet de mutation (backend, module app/parsers/_bibtex.py).

mutmut fait la mutation et exporte mutants/mutmut-cicd-stats.json
(`mutmut export_cicd_stats`). Ce wrapper ne fait QUE le cliquet (regle 8) : il lit
ce JSON et bloque si la qualite des tests REGRESSE, selon DEUX criteres ratchet :

  1. le nombre de SURVIVANTS ne doit pas augmenter (signal local : ferme le trou
     ou un agregat % stable masque une regression ponctuelle) ;
  2. le score = killed / total ne doit pas passer sous le plancher (signal global).

Les deux planchers ne se desserrent jamais (max_survivors ne monte pas,
min_mutation_score ne descend pas). Filet (regle 11) : 0 mutant => echec bruyant.

Codes de sortie :
    0 = pas de regression ;
    1 = survivants en hausse OU score sous le plancher (rouge, bloquant) ;
    2 = stats absentes ou 0 mutant (filet -> on bloque).

Usage :
    python scripts/check_mutation_score.py
    python scripts/check_mutation_score.py --update-floor
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
STATS_PATH = BACKEND_DIR / "mutants" / "mutmut-cicd-stats.json"
FLOOR_PATH = BACKEND_DIR / "mutation-floor.json"
TARGET = "app/parsers/_bibtex.py"


def mutation_score(stats: dict[str, int]) -> float | None:
    """Score = mutants tues / total. None si 0 mutant (filet de securite)."""
    total = stats.get("total", 0)
    if total <= 0:
        return None
    return stats["killed"] / total


def survivor_count(stats: dict[str, int]) -> int:
    """Nombre de mutants survivants (= non tues, le trou que la mutation revele)."""
    return stats.get("survived", 0)


def regressions(score: float, survived: int, min_score: float, max_survivors: int) -> list[str]:
    """Liste des regressions par rapport au plancher (vide = pas de regression)."""
    out: list[str] = []
    if survived > max_survivors:
        out.append(f"survivants {survived} > plafond {max_survivors}")
    if score < min_score:
        out.append(f"score {score:.4f} < plancher {min_score:.4f}")
    return out


def load_floor(path: Path = FLOOR_PATH) -> tuple[float, int]:
    """(min_mutation_score, max_survivors) commites.

    Absent = jour 1 : (0.0, +inf) => le gate ne bloque sur rien (regle 2).
    """
    if not path.exists():
        return 0.0, sys.maxsize
    data = json.loads(path.read_text(encoding="utf-8"))
    return float(data["min_mutation_score"]), int(data["max_survivors"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update-floor",
        action="store_true",
        help="Resserre le plancher a l'etat actuel (refuse tout desserrage).",
    )
    args = parser.parse_args()

    if not STATS_PATH.exists():
        print(
            f"ERREUR : {STATS_PATH.name} absent. Lance 'mutmut run' puis "
            "'mutmut export_cicd_stats' avant ce gate.",
            file=sys.stderr,
        )
        return 2

    stats = json.loads(STATS_PATH.read_text(encoding="utf-8"))
    score = mutation_score(stats)
    if score is None:
        print(
            "ERREUR : 0 mutant genere (config cassee ou module mal cible). "
            "Filet de securite -> echec.",
            file=sys.stderr,
        )
        return 2

    killed, total = stats["killed"], stats["total"]
    survived = survivor_count(stats)
    min_score, max_survivors = load_floor()

    if args.update_floor:
        loosen = regressions(score, survived, min_score, max_survivors)
        if loosen:
            print(
                f"Refus : le plancher ne se desserre jamais ({'; '.join(loosen)}).",
                file=sys.stderr,
            )
            return 1
        FLOOR_PATH.write_text(
            json.dumps(
                {"target": TARGET, "min_mutation_score": score, "max_survivors": survived},
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(
            f"Plancher resserre : score {score:.4f}, survivants {survived} ({killed}/{total} tues)."
        )
        return 0

    print(
        f"Mutation : score {score:.4f} ({killed}/{total} tues), survivants {survived}. "
        f"Plancher : score>={min_score:.4f}, survivants<={max_survivors}."
    )
    regs = regressions(score, survived, min_score, max_survivors)
    if regs:
        print(f"x REGRESSION de qualite des tests : {'; '.join(regs)}.", file=sys.stderr)
        return 1
    print("OK : aucune regression (survivants stables, score >= plancher).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
