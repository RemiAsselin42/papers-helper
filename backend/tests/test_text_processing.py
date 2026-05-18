"""Tests for normalize_text and chunk_text pure functions."""

import re

from app.ingestion import MAX_CHUNK_CHARS, chunk_text, normalize_text


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

    def test_oversized_single_para_is_hard_split(self) -> None:
        """A single huge paragraph must be split so no chunk blows Ollama's
        embedding context window (default 2048 tokens). Cap is target_words*2."""
        big = " ".join(["word"] * 3000)
        chunks = chunk_text(big, target_words=500)
        # 3000 words / cap=1000 → at least 3 chunks
        assert len(chunks) >= 3
        for chunk in chunks:
            assert len(chunk.split()) <= 500 * 2

    def test_hard_cap_preserves_all_words(self) -> None:
        big = " ".join(str(i) for i in range(2500))
        chunks = chunk_text(big, target_words=500)
        rejoined = " ".join(chunks).split()
        assert rejoined == [str(i) for i in range(2500)]

    def test_chunk_contains_all_words(self) -> None:
        text = "foo bar\n\nbaz qux\n\nzap"
        chunks = chunk_text(text, target_words=500)
        rejoined = " ".join(chunks)
        for word in ["foo", "bar", "baz", "qux", "zap"]:
            assert word in rejoined

    def test_chunk_capped_by_chars_not_just_words(self) -> None:
        """A paragraph well under the word cap but with long (glued) words must
        still be split — the char cap is what keeps a chunk embeddable."""
        # 200 words of 60 chars ≈ 12k chars, far under the 1000-word cap.
        para = " ".join(["x" * 60] * 200)
        chunks = chunk_text(para, target_words=500)
        assert len(chunks) > 1
        for chunk in chunks:
            assert len(chunk) <= MAX_CHUNK_CHARS

    def test_unbroken_string_is_hard_sliced(self) -> None:
        """One giant token with no whitespace (a PDF-extraction artefact) is
        hard-sliced so no chunk can blow the embedding context."""
        blob = "a" * (MAX_CHUNK_CHARS * 3 + 100)
        chunks = chunk_text(blob, target_words=500)
        assert len(chunks) >= 3
        for chunk in chunks:
            assert len(chunk) <= MAX_CHUNK_CHARS

    def test_no_chunk_exceeds_char_cap_on_dense_text(self) -> None:
        text = "\n\n".join(" ".join(["motdense"] * 400) for _ in range(20))
        for chunk in chunk_text(text, target_words=500):
            assert len(chunk) <= MAX_CHUNK_CHARS

    def test_content_less_text_yields_no_chunks(self) -> None:
        # Only symbols / punctuation — no word characters → nothing to embed.
        assert chunk_text("••• ●●● —— ··") == []

    def test_symbol_only_chunk_is_dropped(self) -> None:
        # A standalone symbol-only paragraph (after a full bucket) is dropped;
        # the real chunks survive. Guards against NaN embeddings on degenerate
        # input (see _add_chunks_resilient).
        real = " ".join(["mot"] * 600)
        chunks = chunk_text(f"{real}\n\n{'•' * 50}", target_words=500)
        assert len(chunks) >= 1
        assert all(re.search(r"\w", c) for c in chunks)

    def test_explicit_max_chunk_chars_overrides_the_default(self) -> None:
        """The granularity setting feeds `chunk_text` an explicit char cap."""
        para = " ".join(["x" * 50] * 100)  # ~5000 chars, low word count
        small = chunk_text(para, max_chunk_chars=800)
        large = chunk_text(para, max_chunk_chars=3000)
        for chunk in small:
            assert len(chunk) <= 800
        for chunk in large:
            assert len(chunk) <= 3000
        # A tighter cap yields strictly more chunks.
        assert len(small) > len(large)
