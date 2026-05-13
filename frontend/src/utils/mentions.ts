import type { SourceInfo } from '../api/papers'

export interface ActiveMention {
  /** Index of the `@` character in the text (inclusive). */
  start: number
  /** Text between `@` and the caret, excluding the `@`. */
  query: string
}

export interface ParsedMention {
  /** The full matched substring including the `@`. */
  raw: string
  /** Source-type token as written by the user (case unchanged). */
  type: string
  /** Filename token as written by the user. */
  name: string
}

/**
 * Locate the `@`-mention the caret is currently inside, if any. Returns the
 * position of the `@` and the text typed after it. To avoid matching emails
 * (`remi@example.com`), the `@` must be at the start of the text or
 * immediately preceded by whitespace.
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret < 0 || caret > text.length) return null
  const at = text.lastIndexOf('@', caret - 1)
  if (at < 0) return null
  if (at > 0 && !/\s/.test(text[at - 1])) return null
  // Mention is cancelled by whitespace between @ and caret.
  const query = text.slice(at + 1, caret)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

// Matches the `@Type/` prefix only — the filename span is determined by a
// longest-prefix lookup against the actual source list, so filenames with
// spaces (e.g. "Baltes et Dashuber - 2021 - UX Debt.pdf") resolve correctly.
const MENTION_PREFIX_RE = /(^|\s)@([A-Za-z]+)\//g

/**
 * Find every well-formed `@Type/name` substring in the text, resolving the
 * name against the project's known sources. Filenames may contain spaces:
 * for each `@Type/` prefix we pick the longest source filename (of the
 * matching type, case-insensitive) that is a prefix of the text immediately
 * after the slash. If no source matches at a given prefix, that occurrence
 * is skipped.
 */
export function parseMentions(text: string, sources: SourceInfo[]): ParsedMention[] {
  const out: ParsedMention[] = []
  MENTION_PREFIX_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_PREFIX_RE.exec(text)) !== null) {
    const leadingWs = m[1].length
    const tokenStart = m.index + leadingWs // position of `@`
    const type = m[2]
    const afterSlash = tokenStart + 1 + type.length + 1 // past `@Type/`
    const remaining = text.slice(afterSlash)
    const typeLower = type.toLowerCase()
    let bestName: string | null = null
    for (const s of sources) {
      if (s.source_type.toLowerCase() !== typeLower) continue
      if (!remaining.startsWith(s.filename)) continue
      if (bestName === null || s.filename.length > bestName.length) {
        bestName = s.filename
      }
    }
    if (bestName === null) continue
    const end = afterSlash + bestName.length
    out.push({
      raw: text.slice(tokenStart, end),
      type,
      name: bestName,
    })
    // Skip past the resolved filename so the next iteration doesn't re-scan
    // characters we've already consumed (especially relevant for filenames
    // with spaces, which extend past the regex match).
    MENTION_PREFIX_RE.lastIndex = end
  }
  return out
}

/**
 * Replace each parsed `@Type/filename` token in `text` with `« filename »`.
 *
 * Some models interpret the `@Type/file.pdf` syntax as an unresolved
 * attachment reference and refuse to use the injected document content. The
 * detoxified form keeps the user's referential intent visible while removing
 * the at-sigil that triggers the heuristic. Caller is responsible for
 * passing only user-typed text (not assistant/system).
 *
 * Mentions are replaced longest-first so that when one parsed `raw` is a
 * prefix of another (e.g. `@Pdf/foo.pdf` vs `@Pdf/foo.pdf.backup`) the
 * longer match consumes its text before the shorter one can mangle it.
 * `parseMentions` already prefers the longest-prefix source, so this is
 * belt-and-suspenders — but cheap, and it survives future parser changes.
 */
export function detoxMentions(text: string, parsed: ParsedMention[]): string {
  const ordered = [...parsed].sort((a, b) => b.raw.length - a.raw.length)
  let out = text
  for (const p of ordered) {
    out = out.split(p.raw).join(`« ${p.name} »`)
  }
  return out
}

/**
 * Map parsed mentions to existing sources. Type comparison is case-insensitive
 * (`Pdf` ↔ `pdf`); filename comparison is exact. Returns the unique stems of
 * the matched sources, in the order they appear.
 */
export function resolveMentions(parsed: ParsedMention[], sources: SourceInfo[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parsed) {
    const typeLower = p.type.toLowerCase()
    const hit = sources.find(
      (s) => s.source_type.toLowerCase() === typeLower && s.filename === p.name
    )
    if (hit && !seen.has(hit.stem)) {
      seen.add(hit.stem)
      out.push(hit.stem)
    }
  }
  return out
}

/** Capitalise a source type for display (`pdf` → `Pdf`). */
export function displayType(t: string): string {
  if (!t) return t
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
}

function filteredTypes(query: string, sources: SourceInfo[]): string[] {
  const typed = query.toLowerCase()
  const all = Array.from(new Set(sources.map((s) => s.source_type)))
    .map(displayType)
    .sort()
  return typed ? all.filter((t) => t.toLowerCase().startsWith(typed)) : all
}

function filteredFiles(query: string, sources: SourceInfo[]): SourceInfo[] {
  const slashIdx = query.indexOf('/')
  if (slashIdx < 0) return []
  const typeQuery = query.slice(0, slashIdx).toLowerCase()
  const nameQuery = query.slice(slashIdx + 1).toLowerCase()
  return sources
    .filter((s) => s.source_type.toLowerCase() === typeQuery)
    .filter((s) => !nameQuery || s.filename.toLowerCase().includes(nameQuery))
    .slice()
    .sort((a, b) => a.filename.localeCompare(b.filename))
}

/** Count of suggestions the popover would currently render. */
export function mentionItemCount(query: string, sources: SourceInfo[]): number {
  if (query.indexOf('/') < 0) return filteredTypes(query, sources).length
  return filteredFiles(query, sources).length
}

/** Text the popover would insert for `index`, or null if out of range. */
export function mentionInsertion(
  query: string,
  sources: SourceInfo[],
  index: number
): string | null {
  if (query.indexOf('/') < 0) {
    const types = filteredTypes(query, sources)
    if (index < 0 || index >= types.length) return null
    return `${types[index]}/`
  }
  const files = filteredFiles(query, sources)
  if (index < 0 || index >= files.length) return null
  const typeQuery = query.slice(0, query.indexOf('/')).toLowerCase()
  return `${displayType(typeQuery)}/${files[index].filename}`
}

/** Suggestion list shared with the popover for rendering. */
export interface MentionSuggestion {
  /** Text inserted into the textarea when the user picks this entry. */
  insertion: string
  /** Primary label shown in the row. */
  label: string
  /** Optional short tag (the type pill); undefined when listing types. */
  badge?: string
}

export function mentionSuggestions(query: string, sources: SourceInfo[]): MentionSuggestion[] {
  if (query.indexOf('/') < 0) {
    return filteredTypes(query, sources).map((t) => ({
      insertion: `${t}/`,
      label: t,
    }))
  }
  const files = filteredFiles(query, sources)
  const typeQuery = query.slice(0, query.indexOf('/')).toLowerCase()
  const type = displayType(typeQuery)
  return files.map((f) => ({
    insertion: `${type}/${f.filename}`,
    label: f.filename,
    badge: type,
  }))
}
