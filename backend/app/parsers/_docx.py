from __future__ import annotations

from io import BytesIO

import docx

from ._base import ParseResult


def parse_docx(content: bytes, filename: str) -> ParseResult:
    doc = docx.Document(BytesIO(content))

    core = doc.core_properties
    title = (core.title or "").strip()
    author = (core.author or "").strip()
    year = ""
    if core.created:
        year = str(core.created.year)

    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    text = "\n\n".join(paragraphs)

    return ParseResult(text=text, title=title, author=author, year=year, source_type="docx")
