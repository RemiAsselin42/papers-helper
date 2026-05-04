from __future__ import annotations

from striprtf.striprtf import rtf_to_text

from ._base import ParseResult


def parse_rtf(content: bytes, filename: str) -> ParseResult:
    rtf_str = content.decode("utf-8", errors="replace")
    text = rtf_to_text(rtf_str)  # type: ignore[no-untyped-call]
    return ParseResult(text=text, source_type="rtf")
