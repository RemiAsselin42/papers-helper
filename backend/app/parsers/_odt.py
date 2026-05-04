from __future__ import annotations

from io import BytesIO

from odf import teletype
from odf.opendocument import load as odf_load
from odf.text import P

from ._base import ParseResult


def parse_odt(content: bytes, filename: str) -> ParseResult:
    doc = odf_load(BytesIO(content))

    title = ""
    author = ""
    year = ""

    meta_el = doc.meta
    if meta_el is not None:
        # odfpy meta elements
        for el in meta_el.childNodes:
            tag = getattr(el, "qname", (None, None))[1] or ""
            val = teletype.extractText(el).strip()
            if tag == "title" and val:
                title = val
            elif tag in ("initial-creator", "creator") and val and not author:
                author = val
            elif tag == "creation-date" and val:
                year = val[:4] if len(val) >= 4 else ""

    paragraphs = [
        teletype.extractText(p)
        for p in doc.text.getElementsByType(P)
        if teletype.extractText(p).strip()
    ]
    text = "\n\n".join(paragraphs)

    return ParseResult(text=text, title=title, author=author, year=year, source_type="odt")
