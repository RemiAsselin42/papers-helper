from __future__ import annotations

from pathlib import Path

from ._base import ParseResult
from ._bibtex import BibtexEntry, parse_bibtex
from ._docx import parse_docx
from ._epub import parse_epub
from ._html import parse_html
from ._odt import parse_odt
from ._pdf import parse_pdf
from ._rtf import parse_rtf
from ._txt import parse_txt

__all__ = [
    "ParseResult",
    "BibtexEntry",
    "parse",
    "parse_bibtex",
    "SUPPORTED_EXTENSIONS",
    "MANIFEST_EXTENSIONS",
]

MANIFEST_EXTENSIONS: frozenset[str] = frozenset({".bib"})

_PARSERS = {
    ".pdf": parse_pdf,
    ".docx": parse_docx,
    ".txt": parse_txt,
    ".odt": parse_odt,
    ".rtf": parse_rtf,
    ".html": parse_html,
    ".htm": parse_html,
    ".epub": parse_epub,
}

SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(_PARSERS.keys())

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB


def parse(filename: str, content: bytes) -> ParseResult:
    ext = Path(filename).suffix.lower()
    parser = _PARSERS.get(ext)
    if parser is None:
        raise ValueError(f"Format non supporté : {ext or '(sans extension)'}")
    return parser(content, filename)
