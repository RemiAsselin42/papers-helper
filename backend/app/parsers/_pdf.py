from __future__ import annotations

import logging
import re
from io import BytesIO
from typing import Any

from liteparse import LayoutBlock, LiteParse
from pypdf import PdfReader

from ._base import ParseResult

log = logging.getLogger(__name__)

# Text comes from liteparse's layout blocks, which are in reading order and
# exclude running headers/footers — pypdf's extract_text() mixed up two-column
# pages and leaked those into chunks. OCR stays off: it is slow, may fetch
# Tesseract data, and a scanned PDF keeps failing like before.
_PARSER = LiteParse(
    output_format="json",
    extract_blocks=True,
    ocr_enabled=False,
    image_mode="off",
    extract_links=False,
    continue_on_page_error=True,
    max_pages=100_000,  # the default (1000) truncates silently
    quiet=True,
)

# Block text still carries inline Markdown: `**bold**`, `*italic*` and a
# backslash before literal punctuation. liteparse escapes every literal `*`, so
# an unescaped run of `*` is always markup. Chunks must stay plain text: the
# citation view renders them raw and strict matching tokenizes them.
_INLINE_MARKUP = re.compile(r"\\(.)|\*+")


def _block_text(block: LayoutBlock) -> str:
    if block.kind in ("code", "grid_fallback"):
        return "\n".join(block.lines or [])  # verbatim, not escaped
    if block.kind == "table":
        rows = ([block.header] if block.header else []) + list(block.rows or [])
        text = "\n".join(" ".join(c.text for c in row if c.text) for row in rows)
    elif block.kind == "list_item" and block.marker:
        text = f"{block.marker} {block.text or ''}"
    else:
        text = block.text or ""  # heading, paragraph; None for rule and figure
    return _INLINE_MARKUP.sub(r"\1", text)  # an unmatched group substitutes ""


def _info_metadata(content: bytes) -> tuple[str, str, str]:
    """Title, author and year from the /Info dictionary, which liteparse does
    not expose. Best-effort: the text no longer depends on pypdf opening the
    file, so a pypdf failure must not reject a document liteparse can read."""
    try:
        meta: Any = PdfReader(BytesIO(content)).metadata or {}
    except Exception as exc:  # noqa: BLE001 — metadata is optional enrichment
        log.warning("parse_pdf: cannot read /Info metadata: %s", exc)
        return "", "", ""

    title = str(meta.get("/Title") or meta.get("title") or "").strip()
    author = str(meta.get("/Author") or meta.get("author") or "").strip()

    raw_date = str(meta.get("/CreationDate") or meta.get("/ModDate") or "")
    year = ""
    if raw_date:
        m = re.search(r"(\d{4})", raw_date)
        if m:
            candidate = m.group(1)
            if 1900 <= int(candidate) <= 2100:
                year = candidate
    return title, author, year


def parse_pdf(content: bytes, filename: str) -> ParseResult:
    title, author, year = _info_metadata(content)

    result = _PARSER.parse(content)
    if result.page_errors:
        log.warning("parse_pdf: %s — %d page(s) skipped", filename, len(result.page_errors))
    raw = "\n\n".join(
        text
        for page in result.pages
        for block in page.blocks or []
        if (text := _block_text(block).strip())
    )
    return ParseResult(text=raw, title=title, author=author, year=year, source_type="pdf")
