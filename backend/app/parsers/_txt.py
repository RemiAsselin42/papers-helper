from __future__ import annotations

from ._base import ParseResult


def parse_txt(content: bytes, filename: str) -> ParseResult:
    text = content.decode("utf-8", errors="replace")
    return ParseResult(text=text, source_type="txt")
