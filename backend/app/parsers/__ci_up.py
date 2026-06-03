"""DEMO CI Gate 2 — remontee volontaire L1 parsers -> L3 routes. Reverte ensuite."""

from app.routes import papers

# Reference l'import pour qu'il ne soit pas "unused" (ruff F401) : la remontee
# est volontaire, on veut que SEUL le gate de couches echoue, pas le lint.
USED = papers
