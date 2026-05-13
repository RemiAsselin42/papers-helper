import type { SourceInfo } from '../api/projects'

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

const MENTION_RE = /(^|\s)@([A-Za-z]+)\/([^\s@]+)/g

/** Find every well-formed `@Type/name` substring in the text. */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = []
  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.push({ raw: `@${m[2]}/${m[3]}`, type: m[2], name: m[3] })
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
