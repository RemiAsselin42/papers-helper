import { extractBibtexCategories, stripBibtexBraces } from '../../utils/bibtex'
import { EXT_TO_TYPE } from '../../constants/acceptedFormats'
import type { SourceInfo } from '../../api/papers'

export const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  odt: 'ODT',
  rtf: 'RTF',
  html: 'HTML',
  epub: 'EPUB',
  url: 'URL',
}

export type IndexedFilter = 'all' | 'indexed' | 'unindexed'

export interface SourceFilterState {
  search: string
  type: string
  year: string
  category: string
  indexed: IndexedFilter
}

export const NO_YEAR_VALUE = '_none'

export const DEFAULT_FILTERS: SourceFilterState = {
  search: '',
  type: '',
  year: '',
  category: '',
  indexed: 'all',
}

export function isFilterActive(state: SourceFilterState): boolean {
  return (
    state.search.trim() !== '' ||
    state.type !== '' ||
    state.year !== '' ||
    state.category !== '' ||
    state.indexed !== 'all'
  )
}

function normalizeForSearch(s: string): string {
  return stripBibtexBraces(s).toLowerCase()
}

/**
 * Derive the canonical type from the filename extension.
 * source_type from the API can be stale/wrong; the filename extension is stable.
 * Falls back to source_type for url which has no meaningful file extension.
 */
export function resolveType(source: SourceInfo): string {
  if (source.source_type === 'url') return 'url'
  const ext = source.filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_TYPE[ext] ?? source.source_type
}

export function typeFromFilename(filename: string): string {
  if (/^https?:\/\//i.test(filename)) return 'url'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_TYPE[ext] ?? 'document'
}

/**
 * `categoriesByStem` lets callers pre-compute the BibTeX categories once
 * (keyed by stem) and reuse them across renders / filter passes. Avoids
 * re-running the parser for every keystroke in the search box.
 */
export function filterSources(
  sources: SourceInfo[],
  state: SourceFilterState,
  categoriesByStem?: ReadonlyMap<string, readonly string[]>
): SourceInfo[] {
  const needle = normalizeForSearch(state.search).trim()
  return sources.filter((s) => {
    if (needle) {
      const haystack = `${normalizeForSearch(s.pdf_title)} ${normalizeForSearch(s.author)}`
      if (!haystack.includes(needle)) return false
    }
    if (state.type && resolveType(s) !== state.type) return false
    if (state.year) {
      const y = s.year || NO_YEAR_VALUE
      if (y !== state.year) return false
    }
    if (state.category) {
      const cats = categoriesByStem?.get(s.stem) ?? extractBibtexCategories(s.pdf_title)
      if (!cats.includes(state.category)) return false
    }
    if (state.indexed === 'indexed' && !s.indexed) return false
    if (state.indexed === 'unindexed' && s.indexed) return false
    return true
  })
}
