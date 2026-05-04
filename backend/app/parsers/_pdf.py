from __future__ import annotations

import re
from io import BytesIO
from typing import Any

from pypdf import PdfReader

from ._base import ParseResult


def parse_pdf(content: bytes, filename: str) -> ParseResult:
    reader = PdfReader(BytesIO(content))
    meta: Any = reader.metadata or {}

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

    raw = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    return ParseResult(text=raw, title=title, author=author, year=year, source_type="pdf")
