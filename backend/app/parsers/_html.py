from __future__ import annotations

from html.parser import HTMLParser

from ._base import ParseResult

_SKIP_TAGS = frozenset({"script", "style", "head", "nav", "footer", "header"})


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            stripped = data.strip()
            if stripped:
                self._parts.append(stripped)

    def get_text(self) -> str:
        return " ".join(self._parts)


def parse_html(content: bytes, filename: str) -> ParseResult:
    try:
        text_str = content.decode("utf-8", errors="replace")
    except Exception:
        text_str = content.decode("latin-1", errors="replace")

    extractor = _TextExtractor()
    extractor.feed(text_str)
    text = extractor.get_text()
    return ParseResult(text=text, source_type="html")
