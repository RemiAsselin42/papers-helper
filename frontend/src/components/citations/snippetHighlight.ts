/**
 * Highlight model for a citation snippet: bold the searched word(s) and fade
 * words by their distance to the nearest match, so the eye lands on the
 * relevant region of a long (~500-word) chunk.
 *
 * Two matching modes:
 * - tokens (default): every important query word (connective words dropped)
 *   is matched wherever it occurs;
 * - strict: only contiguous occurrences of the exact word sequence match.
 */

import { normalizeWord, STOP_WORDS } from '../../utils/stopWords'

export interface SnippetToken {
  /** Original text, punctuation included. */
  text: string
  /** Separator (spaces / newlines) — rendered verbatim, never faded. */
  whitespace: boolean
  /** Occurrence of a searched word → rendered bold. */
  match: boolean
  /** Render opacity, in [MIN_OPACITY, 1]. */
  opacity: number
}

// Words within this many positions of a match stay fully opaque.
const FULL_RADIUS = 4
// Opacity decays linearly across this many words past the full zone.
const FADE_SPAN = 10
// Distant words never fully vanish — they stay faintly readable.
const MIN_OPACITY = 0.15
// Query tokens shorter than this are ignored (skips stray single letters).
const MIN_TOKEN_LEN = 2

function fadedOpacity(distance: number): number {
  if (distance <= FULL_RADIUS) return 1
  const decayed = 1 - ((distance - FULL_RADIUS) / FADE_SPAN) * (1 - MIN_OPACITY)
  return Math.max(MIN_OPACITY, decayed)
}

/** Token-mode match flags: each important query word, matched anywhere. */
function tokenMatches(normWords: string[], query: string): boolean[] {
  const queryTokens = new Set(
    query
      .split(/\s+/)
      .map(normalizeWord)
      .filter((t) => t.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(t))
  )
  if (queryTokens.size === 0) return normWords.map(() => false)
  return normWords.map((w) => queryTokens.has(w))
}

/** Normalized form of each word in `text`, in order (whitespace dropped). */
function snippetNormWords(text: string): string[] {
  const out: string[] = []
  text.split(/(\s+)/).forEach((part, i) => {
    if (i % 2 === 1 || part === '') return // odd index = whitespace; '' = empty edge
    out.push(normalizeWord(part))
  })
  return out
}

/** Strict-mode match flags: contiguous occurrences of the exact sequence. */
function strictMatches(normWords: string[], query: string): boolean[] {
  const flags = normWords.map(() => false)
  const queryWords = query
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => w !== '')
  if (queryWords.length === 0) return flags
  for (let i = 0; i + queryWords.length <= normWords.length; i++) {
    let hit = true
    for (let k = 0; k < queryWords.length; k++) {
      if (normWords[i + k] !== queryWords[k]) {
        hit = false
        break
      }
    }
    if (hit) {
      for (let k = 0; k < queryWords.length; k++) flags[i + k] = true
    }
  }
  return flags
}

/**
 * Split `text` into render tokens. When nothing matches (no important query
 * word, or no contiguous sequence in strict mode), every word is returned
 * fully opaque and unbolded — the snippet then reads as plain text.
 */
export function buildSnippetTokens(
  text: string,
  query: string,
  strict = false
): SnippetToken[] {
  // Keep separators so newlines / runs of spaces survive (white-space: pre-wrap).
  const parts = text.split(/(\s+)/)
  const normWords = snippetNormWords(text)

  const isMatch = strict
    ? strictMatches(normWords, query)
    : tokenMatches(normWords, query)

  const matchWordIndices = isMatch.flatMap((m, i) => (m ? [i] : []))
  const opacityByWord = normWords.map((_, wi) => {
    if (matchWordIndices.length === 0) return 1
    const nearest = Math.min(...matchWordIndices.map((m) => Math.abs(wi - m)))
    return fadedOpacity(nearest)
  })

  const tokens: SnippetToken[] = []
  let wi = 0
  parts.forEach((part, i) => {
    if (part === '') return
    if (i % 2 === 1) {
      tokens.push({ text: part, whitespace: true, match: false, opacity: 1 })
      return
    }
    tokens.push({
      text: part,
      whitespace: false,
      match: isMatch[wi],
      opacity: opacityByWord[wi],
    })
    wi += 1
  })
  return tokens
}

/**
 * True when `text` contains the exact contiguous word sequence of `query`.
 * Used to drop semantic hits that don't actually carry the searched phrase
 * when strict mode is on.
 */
export function hasStrictMatch(text: string, query: string): boolean {
  return strictMatches(snippetNormWords(text), query).some(Boolean)
}
