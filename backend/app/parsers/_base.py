from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class ParseResult:
    text: str
    title: str = ""
    author: str = ""
    year: str = ""
    source_type: str = "document"


class Parser(Protocol):
    def __call__(self, content: bytes, filename: str) -> ParseResult: ...
