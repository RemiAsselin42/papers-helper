"""DEMO CI Gate 1 — cycle volontaire (sera reverte). Prouve que la CI bloque."""

from app.__ci_cycle_a import ci_a


def ci_b() -> str:
    return f"b -> {ci_a()}"
