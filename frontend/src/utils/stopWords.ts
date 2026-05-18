/**
 * Connective words (articles, prepositions, conjunctions, common pronouns),
 * French and English. Stripped from the citation search query and excluded
 * from snippet highlighting so the important words drive both.
 */

/** Lowercase, strip diacritics, then trim leading/trailing punctuation. */
export function normalizeWord(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

// Stored in normalized form (lowercase, no accents) — "à" → "a", "où" → "ou".
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // — Français —
  'de', 'du', 'des', 'd', 'le', 'la', 'les', 'l', 'un', 'une',
  'et', 'ou', 'ni', 'or', 'mais', 'car', 'donc', 'si',
  'a', 'au', 'aux', 'en', 'dans', 'sur', 'sous', 'pour', 'par',
  'avec', 'sans', 'vers', 'chez', 'entre',
  'ce', 'ces', 'cet', 'cette', 'ceci', 'cela',
  'son', 'sa', 'ses', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes',
  'notre', 'nos', 'votre', 'vos', 'leur', 'leurs',
  'qui', 'que', 'qu', 'quoi', 'dont',
  'ne', 'pas', 'plus', 'est', 'sont', 'se', 's', 't', 'n', 'c', 'm', 'j',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  // — English —
  'the', 'an', 'and', 'but', 'nor', 'so', 'yet',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'without',
  'by', 'from', 'as', 'into', 'over', 'under', 'about',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its',
  'his', 'her', 'their', 'they', 'we', 'you', 'i', 'he', 'she',
  'not', 'no', 'do', 'does', 'did', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'than', 'then', 'such',
])

export function isStopWord(s: string): boolean {
  return STOP_WORDS.has(normalizeWord(s))
}

/**
 * Drop connective words from `text`, keeping the important words in their
 * original casing/accents. Returns `''` when every word was a stop word —
 * callers must decide on a fallback rather than send an empty query.
 */
export function stripStopWords(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => w !== '' && !isStopWord(w))
    .join(' ')
}
