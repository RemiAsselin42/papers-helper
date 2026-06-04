"""Tests du wrapper de cliquet de mutation (scripts/check_mutation_score.py).

On teste UNIQUEMENT la logique maison (regle 8) : calcul du score, comptage des
survivants, double cliquet (survivants + score), filet 0-mutant, lecture du
plancher. mutmut n'est pas sollicite ici (il ne tourne pas sous Windows).

La fixture fixtures/mutmut_cicd_stats_sample.json reproduit le SCHEMA exact ecrit
par mutmut (save_cicd_stats du source mutmut). A reconfirmer contre une vraie
sortie une fois mutmut lance en CI.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "mutmut_cicd_stats_sample.json"


def _load_module():
    if str(_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS))
    spec = importlib.util.spec_from_file_location(
        "check_mutation_score", _SCRIPTS / "check_mutation_score.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cm = _load_module()


# --- score = killed / total + filet 0-mutant --------------------------------


def test_mutation_score_basic() -> None:
    assert cm.mutation_score({"killed": 9, "total": 10}) == 0.9


def test_mutation_score_all_killed() -> None:
    assert cm.mutation_score({"killed": 10, "total": 10}) == 1.0


def test_mutation_score_zero_total_is_none() -> None:
    # 0 mutant -> None : c'est le filet de securite (regle 11).
    assert cm.mutation_score({"killed": 0, "total": 0}) is None


def test_mutation_score_missing_total_is_none() -> None:
    assert cm.mutation_score({"killed": 5}) is None


# --- comptage des survivants ------------------------------------------------


def test_survivor_count() -> None:
    assert cm.survivor_count({"survived": 8}) == 8


def test_survivor_count_default_zero() -> None:
    assert cm.survivor_count({"killed": 10}) == 0


# --- double cliquet : survivants ET score -----------------------------------


def test_no_regression_when_at_floor() -> None:
    assert cm.regressions(0.95, 3, min_score=0.95, max_survivors=3) == []


def test_regression_when_survivors_increase() -> None:
    # Score identique, mais un survivant de plus : DOIT etre attrape (le trou que
    # le gate-sur-survivants ferme).
    regs = cm.regressions(0.95, 4, min_score=0.95, max_survivors=3)
    assert len(regs) == 1
    assert "survivants" in regs[0]


def test_regression_when_score_drops() -> None:
    regs = cm.regressions(0.90, 3, min_score=0.95, max_survivors=3)
    assert len(regs) == 1
    assert "score" in regs[0]


def test_regression_both() -> None:
    assert len(cm.regressions(0.90, 5, min_score=0.95, max_survivors=3)) == 2


# --- lecture du plancher ----------------------------------------------------


def test_load_floor_absent_is_permissive(tmp_path: Path) -> None:
    # Jour 1 (plancher absent) : score>=0 et survivants<=+inf => ne bloque rien.
    min_score, max_survivors = cm.load_floor(tmp_path / "nope.json")
    assert min_score == 0.0
    assert max_survivors == sys.maxsize


def test_load_floor_reads_values(tmp_path: Path) -> None:
    path = tmp_path / "mutation-floor.json"
    path.write_text(
        json.dumps({"min_mutation_score": 0.8125, "max_survivors": 7}), encoding="utf-8"
    )
    assert cm.load_floor(path) == (0.8125, 7)


# --- coherence avec le SCHEMA reel de mutmut (fixture) ----------------------


def test_fixture_uses_real_mutmut_schema() -> None:
    stats = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    # Cles exactes ecrites par save_cicd_stats cote mutmut.
    assert {"killed", "survived", "total", "no_tests", "skipped"} <= set(stats)
    assert cm.mutation_score(stats) == 139 / 150
    assert cm.survivor_count(stats) == 8
