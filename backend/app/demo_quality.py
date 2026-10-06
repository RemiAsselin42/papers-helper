"""Demo for the quality gates, not to merge: one function above the complexity
threshold, one block copied from app/parsers/_bibtex.py."""


def _strip_braces_copy(s: str) -> str:
    """Remove one layer of outer {} if they span the whole string."""
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return s
    depth = 0
    for i, c in enumerate(s):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if depth == 0:
            if i == len(s) - 1:
                s = s[1:-1]
            break
    return s.strip()


def classify(x: int) -> str:
    if x == 0:
        return "zero"
    if x == 1:
        return "one"
    if x == 2:
        return "two"
    if x == 3:
        return "three"
    if x == 4:
        return "four"
    if x == 5:
        return "five"
    if x == 6:
        return "six"
    if x == 7:
        return "seven"
    if x == 8:
        return "eight"
    if x == 9:
        return "nine"
    if x == 10:
        return "ten"
    return "many"
