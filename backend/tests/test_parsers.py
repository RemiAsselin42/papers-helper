"""Tests for the BibTeX and HTML parsers."""

from __future__ import annotations

import json

from app.parsers._bibtex import (
    _extract_file_hints,
    _parse_authors,
    _strip_braces,
    normalize_title,
    parse_bibtex,
)
from app.parsers._html import parse_html

# ---------------------------------------------------------------------------
# BibTeX — low-level helpers
# ---------------------------------------------------------------------------


class TestStripBraces:
    def test_removes_outer_braces(self) -> None:
        assert _strip_braces("{hello}") == "hello"

    def test_nested_braces_preserved(self) -> None:
        assert _strip_braces("{{nested}}") == "{nested}"

    def test_no_braces_unchanged(self) -> None:
        assert _strip_braces("plain") == "plain"

    def test_partial_braces_unchanged(self) -> None:
        assert _strip_braces("{unclosed") == "{unclosed"

    def test_empty_string(self) -> None:
        assert _strip_braces("") == ""

    def test_whitespace_around_braces_stripped(self) -> None:
        assert _strip_braces("  {hello}  ") == "hello"


class TestNormalizeTitle:
    def test_lowercases(self) -> None:
        assert normalize_title("Deep Learning") == "deep learning"

    def test_removes_punctuation(self) -> None:
        assert normalize_title("Hello, World!") == "hello world"

    def test_collapses_whitespace(self) -> None:
        assert normalize_title("a  b") == "a b"

    def test_empty(self) -> None:
        assert normalize_title("") == ""


class TestParseAuthors:
    def test_single_author_family_given(self) -> None:
        flat, json_str = _parse_authors("Smith, John")
        assert flat == "Smith, John"
        authors = json.loads(json_str)
        assert authors == [{"family": "Smith", "given": "John"}]

    def test_multiple_authors_separated_by_and(self) -> None:
        flat, json_str = _parse_authors("Smith, John and Doe, Jane")
        assert "Smith, John" in flat
        assert "Doe, Jane" in flat
        assert flat.count(";") == 1
        authors = json.loads(json_str)
        assert len(authors) == 2

    def test_author_given_then_family(self) -> None:
        flat, json_str = _parse_authors("John Smith")
        assert "Smith" in flat
        authors = json.loads(json_str)
        assert authors[0]["family"] == "Smith"
        assert authors[0]["given"] == "John"

    def test_empty_author_returns_empty(self) -> None:
        flat, json_str = _parse_authors("")
        assert flat == ""
        assert json.loads(json_str) == []


class TestExtractFileHints:
    def test_better_bibtex_format_with_path(self) -> None:
        hints = _extract_file_hints(":C:\\papers\\article.pdf:application/pdf")
        assert hints == ["article.pdf"]

    def test_unix_path(self) -> None:
        hints = _extract_file_hints("::/home/user/docs/paper.pdf:application/pdf")
        assert "paper.pdf" in hints

    def test_multiple_files_separated_by_semicolon(self) -> None:
        hints = _extract_file_hints(":C:\\a.pdf:application/pdf;:C:\\b.pdf:application/pdf")
        assert "a.pdf" in hints
        assert "b.pdf" in hints

    def test_deduplicates(self) -> None:
        hints = _extract_file_hints(":C:\\a.pdf:application/pdf;:D:\\a.pdf:application/pdf")
        assert hints.count("a.pdf") == 1

    def test_empty_string_returns_empty(self) -> None:
        assert _extract_file_hints("") == []

    def test_no_extension_ignored(self) -> None:
        hints = _extract_file_hints(":C:\\noextension:application/pdf")
        assert hints == []


# ---------------------------------------------------------------------------
# BibTeX — parse_bibtex integration
# ---------------------------------------------------------------------------

_SIMPLE_BIB = b"""
@article{smith2020,
  title = {Deep Learning for Science},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  journal = {Nature},
  doi = {10.1000/xyz123},
  abstract = {A great paper.},
}
"""

_BIB_WITH_FILE = b"""
@article{jones2021,
  title = {Neural Networks},
  author = {Jones, Alice},
  year = {2021},
  file = {:C:\\papers\\jones2021.pdf:application/pdf},
}
"""

_BIB_NO_TITLE = b"""
@article{notitle,
  author = {Nobody},
  year = {2000},
}
"""

_BIB_ISO_DATE = b"""
@article{iso2022,
  title = {ISO Date Entry},
  author = {Author, A},
  date = {2022-03-15},
}
"""


class TestParseBibtex:
    def test_parses_basic_entry(self) -> None:
        entries = parse_bibtex(_SIMPLE_BIB)
        assert len(entries) == 1
        e = entries[0]
        assert e.title == "Deep Learning for Science"
        assert "Smith" in e.author
        assert "Doe" in e.author
        assert e.year == "2020"
        assert e.publication == "Nature"
        assert e.doi == "10.1000/xyz123"
        assert e.abstract == "A great paper."

    def test_authors_json_is_valid(self) -> None:
        entries = parse_bibtex(_SIMPLE_BIB)
        authors = json.loads(entries[0].authors_json)
        assert isinstance(authors, list)
        assert len(authors) == 2
        families = {a["family"] for a in authors}
        assert "Smith" in families
        assert "Doe" in families

    def test_entry_without_title_skipped(self) -> None:
        entries = parse_bibtex(_BIB_NO_TITLE)
        assert entries == []

    def test_file_hints_extracted(self) -> None:
        entries = parse_bibtex(_BIB_WITH_FILE)
        assert len(entries) == 1
        assert "jones2021.pdf" in entries[0].file_hints

    def test_iso_date_truncated_to_year(self) -> None:
        entries = parse_bibtex(_BIB_ISO_DATE)
        assert entries[0].year == "2022"

    def test_empty_bib_returns_empty_list(self) -> None:
        assert parse_bibtex(b"") == []

    def test_latin1_encoding_accepted(self) -> None:
        # BibTeX files are sometimes encoded in Latin-1
        content = "@article{a,title={Caf\xe9 Noir},author={X},year={2000},}".encode("latin-1")
        entries = parse_bibtex(content)
        assert len(entries) == 1
        assert "Caf" in entries[0].title

    def test_completely_garbage_input_returns_empty(self) -> None:
        # bibtexparser v1 is lenient and does not raise on malformed input;
        # entries without a title are filtered out, so the result is empty.
        result = parse_bibtex(b"@@@BROKEN{{{")
        assert result == []


# ---------------------------------------------------------------------------
# HTML parser
# ---------------------------------------------------------------------------

_SIMPLE_HTML = b"""
<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Hello</h1>
  <p>This is a paragraph.</p>
  <nav>Navigation text</nav>
  <footer>Footer text</footer>
</body>
</html>
"""

_SCRIPT_HTML = b"""
<html><body>
<p>Visible</p>
<script>var x = 1; alert('hidden');</script>
<style>.foo { color: red; }</style>
<p>Also visible</p>
</body></html>
"""

_EMPTY_HTML = b"<html><body></body></html>"

_NESTED_SKIP_HTML = b"""
<html><body>
<nav>
  <p>Should be skipped</p>
</nav>
<p>Should appear</p>
</body></html>
"""


class TestParseHtml:
    def test_extracts_visible_text(self) -> None:
        result = parse_html(_SIMPLE_HTML, "test.html")
        assert "Hello" in result.text
        assert "This is a paragraph" in result.text

    def test_skips_nav_and_footer(self) -> None:
        result = parse_html(_SIMPLE_HTML, "test.html")
        assert "Navigation text" not in result.text
        assert "Footer text" not in result.text

    def test_skips_script_and_style(self) -> None:
        result = parse_html(_SCRIPT_HTML, "test.html")
        assert "var x" not in result.text
        assert "color: red" not in result.text
        assert "Visible" in result.text
        assert "Also visible" in result.text

    def test_empty_body_returns_empty_text(self) -> None:
        result = parse_html(_EMPTY_HTML, "test.html")
        assert result.text == ""

    def test_source_type_is_html(self) -> None:
        result = parse_html(_SIMPLE_HTML, "test.html")
        assert result.source_type == "html"

    def test_nested_skip_tag_content_excluded(self) -> None:
        result = parse_html(_NESTED_SKIP_HTML, "test.html")
        assert "Should be skipped" not in result.text
        assert "Should appear" in result.text

    def test_latin1_fallback(self) -> None:
        content = "<p>caf\xe9</p>".encode("latin-1")
        # Should not raise, even with non-UTF-8 bytes
        result = parse_html(content, "latin.html")
        assert result.source_type == "html"
