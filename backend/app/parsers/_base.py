from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ParseResult:
    text: str
    title: str = ""
    author: str = ""
    year: str = ""
    source_type: str = "document"
