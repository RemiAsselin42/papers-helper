from __future__ import annotations

import io
from html.parser import HTMLParser

import ebooklib
from ebooklib import epub

from ._base import ParseResult


class _BodyExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            stripped = data.strip()
            if stripped:
                self._parts.append(stripped)

    def get_text(self) -> str:
        return " ".join(self._parts)


def parse_epub(content: bytes, filename: str) -> ParseResult:
    book = epub.read_epub(io.BytesIO(content))

    title = book.get_metadata("DC", "title")
    title_str = title[0][0] if title else ""

    creators = book.get_metadata("DC", "creator")
    author_str = creators[0][0] if creators else ""

    dates = book.get_metadata("DC", "date")
    year_str = ""
    if dates:
        raw = dates[0][0]
        year_str = raw[:4] if len(raw) >= 4 else raw

    parts: list[str] = []
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        extractor = _BodyExtractor()
        extractor.feed(item.get_content().decode("utf-8", errors="replace"))
        chunk = extractor.get_text()
        if chunk:
            parts.append(chunk)

    return ParseResult(
        text="\n\n".join(parts),
        title=title_str,
        author=author_str,
        year=year_str,
        source_type="epub",
    )
