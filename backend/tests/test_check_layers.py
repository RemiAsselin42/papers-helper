"""Tests du gate de couches (scripts/check_layers.py).

1. find_upward_edges() sur graphes JOUETS : remontee illegale (rouge), descente
   legale (verte), deux modules de meme couche (OK), source non classee ignoree.
2. Classification (area / rank_of / unclassified_modules).
3. Invariants sur l'app REELLE : zero module non classe, et toute remontee
   actuelle est deja dans le baseline (= le gate est vert). Ces deux tests
   verrouillent la hierarchie approuvee.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"


def _load_layers_module():
    # check_layers importe check_import_cycles : il faut scripts/ sur sys.path.
    if str(_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS))
    spec = importlib.util.spec_from_file_location("check_layers", _SCRIPTS / "check_layers.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cl = _load_layers_module()


class _FakeGraph:
    """Graphe minimal : `succ[m]` = modules importes directement par `m`."""

    def __init__(self, succ: dict[str, set[str]]) -> None:
        nodes = set(succ)
        for targets in succ.values():
            nodes |= targets
        self._succ = {n: set(succ.get(n, set())) for n in nodes}

    @property
    def modules(self) -> set[str]:
        return set(self._succ)

    def find_modules_directly_imported_by(self, module: str) -> set[str]:
        return set(self._succ[module])


def _rank(mapping: dict[str, int]):
    return lambda module: mapping.get(module)


# --- 1. Algorithme de remontee sur graphes jouets --------------------------


def test_upward_edge_is_flagged() -> None:
    graph = _FakeGraph({"low": {"high"}})
    assert cl.find_upward_edges(graph, _rank({"low": 0, "high": 1})) == [("low", "high")]


def test_downward_edge_is_allowed() -> None:
    graph = _FakeGraph({"high": {"low"}})
    assert cl.find_upward_edges(graph, _rank({"low": 0, "high": 1})) == []


def test_same_layer_edge_is_allowed() -> None:
    # Deux modules de MEME couche qui s'importent mutuellement : autorise
    # (c'est ce qui permet au cluster graph<->ingestion de tenir dans une couche).
    graph = _FakeGraph({"a": {"b"}, "b": {"a"}})
    assert cl.find_upward_edges(graph, _rank({"a": 0, "b": 0})) == []


def test_unclassified_source_is_skipped() -> None:
    # Un module sans couche (rank None) ne genere pas de fausse remontee ;
    # il est traite a part par unclassified_modules().
    graph = _FakeGraph({"x": {"high"}})
    assert cl.find_upward_edges(graph, _rank({"high": 1})) == []


# --- 2. Classification -----------------------------------------------------


def test_area_groups_namespace_subpackages() -> None:
    assert cl.area("app.routes.papers") == "app.routes"
    assert cl.area("app.graph.builder") == "app.graph"
    assert cl.area("app.parsers._pdf") == "app.parsers"
    assert cl.area("app.config") == "app.config"


def test_rank_of_known_and_unknown() -> None:
    ranks = cl.area_rank()
    assert cl.rank_of("app.config", ranks) == 0
    assert cl.rank_of("app.routes.papers", ranks) == 3
    assert cl.rank_of("app.totally_new", ranks) is None


def test_unclassified_modules_detected() -> None:
    graph = _FakeGraph({"app.config": set(), "app.mystery": set()})
    assert cl.unclassified_modules(graph) == ["app.mystery"]


def test_unclassified_namespace_subpackage_triggers_safety_net() -> None:
    # Cas fragile : un sous-paquet NAMESPACE neuf (app/__newpkg/foo.py sans
    # __init__.py), multi-niveau et hors routes/graph/parsers. area() ne le
    # traite PAS specialement -> il garde son nom complet -> rank_of None ->
    # le filet le signale au lieu de le rattacher silencieusement a une couche.
    foo = "app.newpkg.foo"
    assert cl.area(foo) == "app.newpkg.foo"  # pas coerce vers une zone connue
    assert cl.rank_of(foo, cl.area_rank()) is None
    graph = _FakeGraph({"app.config": set(), "app.newpkg": set(), "app.newpkg.foo": set()})
    assert cl.unclassified_modules(graph) == ["app.newpkg", "app.newpkg.foo"]


# --- 3. Invariants sur l'app reelle ----------------------------------------


def test_real_app_has_no_unclassified_module() -> None:
    graph = cl.cycles_gate.build_app_graph()
    assert cl.unclassified_modules(graph) == []


def test_real_app_upward_edges_are_all_baselined() -> None:
    graph = cl.cycles_gate.build_app_graph()
    ranks = cl.area_rank()
    current = set(cl.find_upward_edges(graph, lambda m: cl.rank_of(m, ranks)))
    assert current <= cl.load_baseline()  # le gate est vert : rien hors baseline
