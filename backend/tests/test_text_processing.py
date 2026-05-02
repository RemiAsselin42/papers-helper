"""Tests for normalize_text and chunk_text pure functions."""

from app.routes.papers import chunk_text, normalize_text


class TestNormalizeText:
    def test_hyphenated_line_break_joined(self) -> None:
        assert normalize_text("algo-\nrithm") == "algorithm"

    def test_soft_wrap_becomes_space(self) -> None:
        assert normalize_text("hello\nworld") == "hello world"

    def test_paragraph_break_preserved(self) -> None:
        result = normalize_text("para one\n\npara two")
        assert result == "para one\n\npara two"

    def test_multiple_spaces_collapsed(self) -> None:
        assert normalize_text("foo   bar") == "foo bar"

    def test_excess_blank_lines_collapsed(self) -> None:
        result = normalize_text("a\n\n\n\nb")
        assert result == "a\n\nb"

    def test_leading_trailing_whitespace_stripped(self) -> None:
        assert normalize_text("  hello  ") == "hello"

    def test_empty_string(self) -> None:
        assert normalize_text("") == ""

    def test_combined_artefacts(self) -> None:
        raw = "deep   learn-\ning\nis  great\n\n\n\nnew para"
        result = normalize_text(raw)
        assert result == "deep learning is great\n\nnew para"


class TestChunkText:
    def test_single_short_para_is_one_chunk(self) -> None:
        chunks = chunk_text("short paragraph", target_words=500)
        assert chunks == ["short paragraph"]

    def test_empty_text_returns_empty(self) -> None:
        assert chunk_text("") == []

    def test_splits_at_word_boundary(self) -> None:
        words = " ".join(["word"] * 300)
        para_a = words
        para_b = words
        text = f"{para_a}\n\n{para_b}"
        chunks = chunk_text(text, target_words=500)
        # 300+300 = 600 > 500 → two separate chunks
        assert len(chunks) == 2

    def test_paragraphs_below_target_merged(self) -> None:
        para_a = " ".join(["a"] * 100)
        para_b = " ".join(["b"] * 100)
        text = f"{para_a}\n\n{para_b}"
        chunks = chunk_text(text, target_words=500)
        assert len(chunks) == 1
        assert "a" in chunks[0] and "b" in chunks[0]

    def test_blank_paragraphs_ignored(self) -> None:
        text = "para one\n\n   \n\npara two"
        chunks = chunk_text(text, target_words=500)
        assert len(chunks) == 1

    def test_oversized_single_para_stays_one_chunk(self) -> None:
        big = " ".join(["word"] * 1000)
        chunks = chunk_text(big, target_words=500)
        # A single paragraph that exceeds target — no split point, goes in as-is
        assert len(chunks) == 1

    def test_chunk_contains_all_words(self) -> None:
        text = "foo bar\n\nbaz qux\n\nzap"
        chunks = chunk_text(text, target_words=500)
        rejoined = " ".join(chunks)
        for word in ["foo", "bar", "baz", "qux", "zap"]:
            assert word in rejoined
