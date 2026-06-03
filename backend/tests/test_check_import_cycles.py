"""Tests du gate de cycles d'import (scripts/check_import_cycles.py).

Deux familles :
1. find_cycles() sur des graphes JOUETS connus (algorithme pur, controle total) :
   cycle a 3 noeuds, auto-import, diamant (PAS un cycle), cycle en sous-paquet,
   cycles disjoints. C'est ce qui protege des cas qu'aucune demo manuelle ne couvre.
2. Integration disque/grimp sur des arbres temporaires : la partie CUSTOM fragile
   (decouverte des namespace packages + filet de securite) est verifiee de bout
   en bout, y compris sur un sous-paquet cree a la volee.
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path

import grimp

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_import_cycles.py"


def _load_gate_module():
    """Charge le script (qui n'est pas un paquet importable) par son chemin."""
    spec = importlib.util.spec_from_file_location("check_import_cycles", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cic = _load_gate_module()


class _FakeGraph:
    """Graphe d'imports minimal : juste ce dont find_cycles() a besoin.

    `succ[m]` = ensemble des modules importes directement par `m`.
    """

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


# --- 1. find_cycles() sur graphes jouets -----------------------------------


def test_three_node_cycle() -> None:
    graph = _FakeGraph({"a": {"b"}, "b": {"c"}, "c": {"a"}})
    assert cic.find_cycles(graph) == [("a", "b", "c")]


def test_self_import_is_a_cycle() -> None:
    graph = _FakeGraph({"a": {"a"}})
    assert cic.find_cycles(graph) == [("a",)]


def test_diamond_is_not_a_cycle() -> None:
    # a -> b -> d et a -> c -> d : convergence, mais AUCUNE arete retour => pas de cycle.
    graph = _FakeGraph({"a": {"b", "c"}, "b": {"d"}, "c": {"d"}, "d": set()})
    assert cic.find_cycles(graph) == []


def test_cycle_in_subpackage() -> None:
    graph = _FakeGraph({"pkg.sub.a": {"pkg.sub.b"}, "pkg.sub.b": {"pkg.sub.a"}})
    assert cic.find_cycles(graph) == [("pkg.sub.a", "pkg.sub.b")]


def test_two_disjoint_cycles_plus_acyclic_nodes() -> None:
    graph = _FakeGraph(
        {
            "a": {"b"},
            "b": {"a"},  # cycle 1
            "c": {"d"},
            "d": {"c"},  # cycle 2
            "e": {"a"},  # pointe vers un cycle mais n'en fait pas partie
            "f": set(),  # isole
        }
    )
    assert cic.find_cycles(graph) == [("a", "b"), ("c", "d")]


def test_no_edges_no_cycle() -> None:
    assert cic.find_cycles(_FakeGraph({"a": set(), "b": set()})) == []


# --- 2. Integration disque / grimp / namespace packages --------------------


def _write(base: Path, rel: str, content: str = "") -> None:
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@contextlib.contextmanager
def _on_syspath(root: Path, top: str) -> Iterator[None]:
    """Rend `root` importable le temps du bloc, puis nettoie sys.path/sys.modules."""
    root_str = str(root)
    sys.path.insert(0, root_str)
    importlib.invalidate_caches()
    try:
        yield
    finally:
        if root_str in sys.path:
            sys.path.remove(root_str)
        for name in [n for n in list(sys.modules) if n == top or n.startswith(f"{top}.")]:
            del sys.modules[name]
        importlib.invalidate_caches()


def test_discover_finds_a_new_namespace_package(tmp_path: Path) -> None:
    # discover_packages() est dynamique : un sous-paquet cree apres coup doit etre
    # trouve sans aucune liste codee en dur.
    _write(tmp_path, "discpkg/__init__.py")
    _write(tmp_path, "discpkg/freshpkg/m.py", "x = 1\n")  # PAS de __init__ -> namespace
    roots = cic.discover_packages(app_dir=tmp_path / "discpkg", backend_dir=tmp_path)
    assert "discpkg" in roots
    assert "discpkg.freshpkg" in roots


def test_gate_catches_cycle_inside_namespace_subpackage(tmp_path: Path) -> None:
    # Deux modules qui s'importent l'un l'autre, ENTIEREMENT dans un namespace
    # package : c'est le cas que la demo racine ne couvrait pas.
    _write(tmp_path, "gatepkg/__init__.py")
    _write(tmp_path, "gatepkg/routers/a.py", "import gatepkg.routers.b\n")
    _write(tmp_path, "gatepkg/routers/b.py", "import gatepkg.routers.a\n")
    with _on_syspath(tmp_path, "gatepkg"):
        roots = cic.discover_packages(app_dir=tmp_path / "gatepkg", backend_dir=tmp_path)
        assert "gatepkg.routers" in roots  # le namespace package est bien decouvert
        cycles = cic.find_cycles(grimp.build_graph(*roots, cache_dir=None))
    assert any({"gatepkg.routers.a", "gatepkg.routers.b"} <= set(cycle) for cycle in cycles)


def test_expected_modules_catches_what_discovery_would_miss(tmp_path: Path) -> None:
    # expected_modules() lit le disque INDEPENDAMMENT de la decouverte/grimp.
    # On simule une decouverte cassee (build_graph du seul paquet regulier) et on
    # verifie que le filet remonte le module du namespace package.
    _write(tmp_path, "misspkg/__init__.py")
    _write(tmp_path, "misspkg/regular/__init__.py")
    _write(tmp_path, "misspkg/regular/mod.py", "v = 1\n")
    _write(tmp_path, "misspkg/nspkg/hidden.py", "v = 1\n")  # namespace -> rate par grimp seul
    expected = cic.expected_modules(app_dir=tmp_path / "misspkg", backend_dir=tmp_path)
    assert "misspkg.nspkg.hidden" in expected
    with _on_syspath(tmp_path, "misspkg"):
        incomplete = grimp.build_graph("misspkg", cache_dir=None).modules
    assert "misspkg.nspkg.hidden" not in incomplete
    assert "misspkg.nspkg.hidden" in (expected - incomplete)  # le filet se declencherait


def test_type_checking_only_cycle_is_not_a_runtime_cycle(tmp_path: Path) -> None:
    # a -> b UNIQUEMENT sous `if TYPE_CHECKING:` ; b -> a au runtime. Le cycle
    # n'existe donc qu'au niveau des types. Le gate (exclude_type_checking_imports
    # =True, comme le frontend) doit l'IGNORER ; c'est ce qui rend l'idiome de
    # cassage de cycle (deplacer un import sous TYPE_CHECKING) compatible.
    _write(tmp_path, "tcpkg/__init__.py")
    _write(
        tmp_path,
        "tcpkg/a.py",
        "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from tcpkg import b\n",
    )
    _write(tmp_path, "tcpkg/b.py", "from tcpkg import a\n")
    with _on_syspath(tmp_path, "tcpkg"):
        runtime = cic.find_cycles(
            grimp.build_graph("tcpkg", exclude_type_checking_imports=True, cache_dir=None)
        )
        with_types = cic.find_cycles(
            grimp.build_graph("tcpkg", exclude_type_checking_imports=False, cache_dir=None)
        )
    # Sans le flag, grimp voit le cycle de types ; avec le flag (= le gate), non.
    assert any({"tcpkg.a", "tcpkg.b"} <= set(cycle) for cycle in with_types)
    assert all({"tcpkg.a", "tcpkg.b"} - set(cycle) for cycle in runtime)
