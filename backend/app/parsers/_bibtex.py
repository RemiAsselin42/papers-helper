from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import bibtexparser


@dataclass
class BibtexEntry:
    key: str
    title: str
    author: str
    authors_json: str
    year: str
    publication: str
    doi: str
    abstract: str
    file_hints: list[str] = field(default_factory=list)


def normalize_title(title: str) -> str:
    t = title.lower()
    t = re.sub(r"[^\w\s]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _strip_braces(s: str) -> str:
    """Remove one layer of outer {} if they span the whole string."""
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return s
    depth = 0
    for i, c in enumerate(s):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if depth == 0:
            if i == len(s) - 1:
                s = s[1:-1]
            break
    return s.strip()


def _get(entry: dict[str, str], key: str) -> str:
    return _strip_braces(entry.get(key, ""))


def _parse_authors(author_str: str) -> tuple[str, str]:
    raw_names = re.split(r"\s+and\s+", author_str, flags=re.IGNORECASE)
    author_parts: list[str] = []
    authors_list: list[dict[str, str]] = []

    for name in raw_names:
        name = _strip_braces(name.strip())
        if not name:
            continue
        if "," in name:
            comma_idx = name.index(",")
            family = _strip_braces(name[:comma_idx])
            given = _strip_braces(name[comma_idx + 1 :])
        else:
            words = name.split()
            if len(words) >= 2:
                family = words[-1]
                given = " ".join(words[:-1])
            else:
                family = name
                given = ""

        if family:
            label = f"{family}, {given}".rstrip(", ")
            author_parts.append(label)
            authors_list.append({"family": family, "given": given})

    return " ; ".join(author_parts), json.dumps(authors_list, ensure_ascii=False)


def _extract_file_hints(file_str: str) -> list[str]:
    """Extract PDF basenames from a BibTeX/Better BibTeX file field value.

    Better BibTeX format per segment: "description:path:mime"
    Multiple files separated by ";".
    """
    hints: list[str] = []
    file_str = _strip_braces(file_str)

    for segment in file_str.split(";"):
        segment = segment.strip()
        if not segment:
            continue

        parts = segment.split(":")
        found = False

        # Look for the part that contains a path separator (Unix or Windows)
        for part in parts:
            part = part.strip()
            if ("/" in part or "\\" in part) and part:
                name = Path(part.replace("\\", "/")).name
                if name and "." in name:
                    hints.append(name)
                    found = True
                    break

        if not found and len(parts) >= 2:
            # No path separator — try the second token (e.g., ":filename.pdf:mime")
            candidate = parts[1].strip()
            if "." in candidate and candidate:
                hints.append(Path(candidate).name)

    return list(dict.fromkeys(hints))  # deduplicate, preserve order


def parse_bibtex(content: bytes) -> list[BibtexEntry]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    try:
        library = bibtexparser.parse_string(text)  # type: ignore[attr-defined]
    except Exception as e:
        raise ValueError(f"Erreur de parsing BibTeX : {e}") from e

    entries: list[BibtexEntry] = []

    for entry in library.entries:
        raw = {f.key: f.value for f in entry.fields}

        title = _get(raw, "title")
        if not title:
            continue

        author_str = _get(raw, "author")
        author_flat, authors_json_str = _parse_authors(author_str) if author_str else ("", "[]")

        year = _get(raw, "year") or _get(raw, "date")
        if year and "-" in year:
            year = year.split("-")[0]

        publication = (
            _get(raw, "journal")
            or _get(raw, "booktitle")
            or _get(raw, "publisher")
            or ""
        )

        doi = _get(raw, "doi")
        abstract = _get(raw, "abstract")

        file_str = _get(raw, "file")
        file_hints = _extract_file_hints(file_str) if file_str else []

        entries.append(
            BibtexEntry(
                key=entry.key,
                title=title,
                author=author_flat,
                authors_json=authors_json_str,
                year=year,
                publication=publication,
                doi=doi,
                abstract=abstract,
                file_hints=file_hints,
            )
        )

    return entries
