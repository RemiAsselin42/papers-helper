/**
 * Frontend mirror of the backend's `split_categories` (app/graph/build.py).
 * Splits on both `,` and `;`, trims, dedups case-insensitively while
 * preserving the first-seen casing. Must stay in sync — both ends parse
 * the same `meta.categories` string and need to agree on the resulting set.
 */
export function splitCategoriesCsv(s: string): string[] {
  if (!s) return []
  const pieces = s
    .split(';')
    .flatMap((part) => part.split(','))
    .map((p) => p.trim())
  const seen = new Map<string, string>()
  for (const p of pieces) {
    if (!p) continue
    const key = p.toLowerCase()
    if (!seen.has(key)) seen.set(key, p)
  }
  return Array.from(seen.values())
}

/**
 * Merge any number of category lists case-insensitively, keeping the
 * first-seen casing across all of them. Used to combine existing
 * `source.categories` with LLM-suggested categories on enrichment.
 */
export function mergeCategories(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Map<string, string>()
  for (const list of lists) {
    for (const raw of list) {
      const v = raw.trim()
      if (!v) continue
      const key = v.toLowerCase()
      if (!seen.has(key)) seen.set(key, v)
    }
  }
  return Array.from(seen.values())
}

/**
 * Tolerant parser for an LLM-emitted list of short strings — handles the
 * three shapes small local models tend to produce:
 *   1. A clean JSON array `["A","B","C"]` (the prompted format).
 *   2. A JSON-ish array with curly quotes / trailing commas / single quotes.
 *   3. A bulleted or numbered list (`- A\n- B`, `1. A\n2. B`, etc).
 *
 * Returns a deduped (case-insensitive) list of trimmed strings, capped at
 * `max`. Returns `[]` only when nothing usable could be salvaged.
 */
export function parseLlmStringArray(text: string, max = 8): string[] {
  if (!text) return []
  let s = text.trim()
  if (s.startsWith('```')) {
    const firstNl = s.indexOf('\n')
    if (firstNl !== -1) s = s.slice(firstNl + 1)
    if (s.endsWith('```')) s = s.slice(0, -3)
    s = s.trim()
  }

  const fromJson = tryJsonArray(s)
  if (fromJson.length > 0) return capDedupe(fromJson, max)

  const normalized = normalizeQuotes(s).replace(/,(\s*[\]}])/g, '$1')
  const fromNormalized = tryJsonArray(normalized)
  if (fromNormalized.length > 0) return capDedupe(fromNormalized, max)

  // Last resort: scrape one label per line. Catches prose like
  // "1. Utilisabilité\n2. Web design\n…" or "- A\n- B".
  return capDedupe(extractLineLabels(s), max)
}

function tryJsonArray(s: string): string[] {
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  try {
    const raw = JSON.parse(s.slice(start, end + 1))
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function normalizeQuotes(s: string): string {
  return s
    .replace(/[“”]/g, '"') // “ ” → "
    .replace(/[‘’]/g, "'") // ‘ ’ → '
}

function extractLineLabels(s: string): string[] {
  // Only keep lines that *look* like list items — a leading bullet, a
  // numbered prefix, or a wrapping quote pair. Plain prose lines are
  // dropped to avoid false positives like "Voici les catégories :".
  const listLine = /^\s*(?:[-*•·–—]+|\d+[.)\]]|["'`“‘])\s*(.+)$/
  // Trailing class includes `]` `}` so JSON-array artefacts (a label scraped
  // from `  "Education"]` — the last element of a one-per-line array) don't
  // leave a stray `"]` glued to the category name.
  const trimQuotes = /^["'`“‘[{]+|[",.;:`”’\]}]+\s*$/g
  const out: string[] = []
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(listLine)
    if (!m) continue
    let v = m[1].trim()
    // Strip a trailing quote/punct or leading stray quote from the captured
    // body (the regex catches the leading wrapper but the body may carry one).
    v = v.replace(trimQuotes, '').trim()
    if (v) out.push(v)
  }
  return out
}

function capDedupe(values: string[], max: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const cleaned = v.trim()
    if (!cleaned || cleaned.length > 80) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= max) break
  }
  return out
}
