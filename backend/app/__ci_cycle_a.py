"""DEMO CI Gate 1 — cycle volontaire (sera reverte). Prouve que la CI bloque."""

from app.__ci_cycle_b import ci_b


def ci_a() -> str:
    return f"a -> {ci_b()}"
