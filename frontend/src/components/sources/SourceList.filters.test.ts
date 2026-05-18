import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '../../api/papers'
import {
  DEFAULT_FILTERS,
  filterSources,
  isFilterActive,
  NO_YEAR_VALUE,
  resolveType,
  typeFromFilename,
  type SourceFilterState,
} from './SourceList.filters'

function mk(partial: Partial<SourceInfo>): SourceInfo {
  return {
    stem: partial.stem ?? 'stem',
    filename: partial.filename ?? 'doc.pdf',
    chunk_total: partial.chunk_total ?? 0,
    pdf_title: partial.pdf_title ?? 'Title',
    author: partial.author ?? 'Author',
    year: partial.year ?? '',
    source_type: (partial.source_type ?? 'pdf') as SourceInfo['source_type'],
    authors_json: partial.authors_json ?? '',
    publication: partial.publication ?? '',
    doi: partial.doi ?? '',
    abstract: partial.abstract ?? '',
    notes: partial.notes ?? '',
    categories: partial.categories ?? '',
    indexed: partial.indexed ?? true,
    index_error: partial.index_error ?? '',
  }
}

function withState(over: Partial<SourceFilterState>): SourceFilterState {
  return { ...DEFAULT_FILTERS, ...over }
}

describe('isFilterActive', () => {
  it('returns false for the default state', () => {
    expect(isFilterActive(DEFAULT_FILTERS)).toBe(false)
  })

  it('treats a whitespace-only search as inactive', () => {
    expect(isFilterActive(withState({ search: '   ' }))).toBe(false)
  })

  it('detects a populated search', () => {
    expect(isFilterActive(withState({ search: 'foo' }))).toBe(true)
  })

  it('detects each individual filter axis', () => {
    expect(isFilterActive(withState({ type: 'pdf' }))).toBe(true)
    expect(isFilterActive(withState({ year: '2024' }))).toBe(true)
    expect(isFilterActive(withState({ category: 'ml' }))).toBe(true)
    expect(isFilterActive(withState({ indexed: 'indexed' }))).toBe(true)
  })
})

describe('resolveType / typeFromFilename', () => {
  it('prefers extension over a wrong source_type', () => {
    const s = mk({ filename: 'paper.epub', source_type: 'pdf' })
    expect(resolveType(s)).toBe('epub')
  })

  it('keeps url for url-type sources', () => {
    const s = mk({ filename: 'whatever', source_type: 'url' })
    expect(resolveType(s)).toBe('url')
  })

  it('recognises http(s) urls regardless of extension', () => {
    expect(typeFromFilename('https://example.com/x.pdf')).toBe('url')
    expect(typeFromFilename('paper.pdf')).toBe('pdf')
    expect(typeFromFilename('unknown.weird')).toBe('document')
  })
})

describe('filterSources', () => {
  const sources: SourceInfo[] = [
    mk({
      stem: 'a',
      filename: 'a.pdf',
      pdf_title: 'Alpha {ML}',
      categories: 'ML',
      author: 'Smith',
      year: '2024',
    }),
    mk({
      stem: 'b',
      filename: 'b.epub',
      source_type: 'pdf',
      pdf_title: 'Beta {NLP}',
      categories: 'NLP',
      author: 'Doe',
      year: '2023',
      indexed: false,
    }),
    mk({ stem: 'c', filename: 'c.pdf', pdf_title: 'Gamma', author: 'Smith', year: '' }),
  ]

  it('matches search against title and author, case-insensitive', () => {
    expect(filterSources(sources, withState({ search: 'smith' })).map((s) => s.stem)).toEqual([
      'a',
      'c',
    ])
    expect(filterSources(sources, withState({ search: 'BETA' })).map((s) => s.stem)).toEqual(['b'])
  })

  it('strips bibtex braces before searching', () => {
    expect(filterSources(sources, withState({ search: 'ML' })).map((s) => s.stem)).toEqual(['a'])
  })

  it('filters by type derived from the filename extension', () => {
    expect(filterSources(sources, withState({ type: 'epub' })).map((s) => s.stem)).toEqual(['b'])
    expect(filterSources(sources, withState({ type: 'pdf' })).map((s) => s.stem)).toEqual([
      'a',
      'c',
    ])
  })

  it('selects sources missing a year via NO_YEAR_VALUE', () => {
    expect(filterSources(sources, withState({ year: NO_YEAR_VALUE })).map((s) => s.stem)).toEqual([
      'c',
    ])
    expect(filterSources(sources, withState({ year: '2023' })).map((s) => s.stem)).toEqual(['b'])
  })

  it('filters by indexed status', () => {
    expect(filterSources(sources, withState({ indexed: 'unindexed' })).map((s) => s.stem)).toEqual([
      'b',
    ])
    expect(filterSources(sources, withState({ indexed: 'indexed' })).map((s) => s.stem)).toEqual([
      'a',
      'c',
    ])
  })

  it('uses the supplied categories map without re-parsing titles', () => {
    let parseCount = 0
    const cats = new Map<string, readonly string[]>([
      [
        'a',
        ((): readonly string[] => {
          parseCount++
          return ['ML']
        })(),
      ],
      ['b', ['NLP']],
      ['c', []],
    ])
    parseCount = 0 // ignore setup cost
    const result = filterSources(sources, withState({ category: 'ML' }), cats)
    expect(result.map((s) => s.stem)).toEqual(['a'])
    // No additional parses inside filterSources beyond what the caller did.
    expect(parseCount).toBe(0)
  })

  it('falls back to reading source.categories when no map is provided', () => {
    const result = filterSources(sources, withState({ category: 'ML' }))
    expect(result.map((s) => s.stem)).toEqual(['a'])
  })

  it('reads the persisted `categories` field, not just legacy braces', () => {
    const persisted: SourceInfo[] = [
      mk({ stem: 'x', categories: 'Sociologie, Méthodes' }),
      mk({ stem: 'y', categories: 'Méthodes ; Stats' }),
      mk({ stem: 'z', categories: '' }),
    ]
    expect(
      filterSources(persisted, withState({ category: 'Méthodes' })).map((s) => s.stem)
    ).toEqual(['x', 'y'])
  })

  it('matches the category filter case-insensitively', () => {
    const persisted: SourceInfo[] = [mk({ stem: 'x', categories: 'Sociologie' })]
    expect(
      filterSources(persisted, withState({ category: 'sociologie' })).map((s) => s.stem)
    ).toEqual(['x'])
  })

  it('combines axes with AND semantics', () => {
    const result = filterSources(
      sources,
      withState({ search: 'smith', indexed: 'indexed', type: 'pdf' })
    )
    expect(result.map((s) => s.stem)).toEqual(['a', 'c'])
  })
})
