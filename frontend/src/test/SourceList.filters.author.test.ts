import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS,
  filterSources,
  isFilterActive,
  type SourceFilterState,
} from '../components/sources/SourceList.filters'
import type { SourceInfo } from '../api/papers'

function mk(partial: Partial<SourceInfo>): SourceInfo {
  return {
    stem: partial.stem ?? 'stem',
    filename: partial.filename ?? 'doc.pdf',
    chunk_total: partial.chunk_total ?? 0,
    pdf_title: partial.pdf_title ?? '',
    author: partial.author ?? '',
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

function withFilter(over: Partial<SourceFilterState>): SourceFilterState {
  return { ...DEFAULT_FILTERS, ...over }
}

describe('SourceList.filters — author axis', () => {
  it('treats an empty author filter as inactive', () => {
    expect(isFilterActive(withFilter({ author: '' }))).toBe(false)
    expect(isFilterActive(withFilter({ author: '   ' }))).toBe(false)
  })

  it('detects a populated author filter', () => {
    expect(isFilterActive(withFilter({ author: 'Smith' }))).toBe(true)
  })

  it('matches against the flat author string (substring, case-insensitive)', () => {
    const sources = [
      mk({ stem: 'a', author: 'Smith, John ; Doe, Jane' }),
      mk({ stem: 'b', author: 'Roe, Mike' }),
    ]
    const filtered = filterSources(sources, withFilter({ author: 'smith' }))
    expect(filtered.map((s) => s.stem)).toEqual(['a'])
  })

  it('matches against authors_json too', () => {
    const sources = [
      mk({
        stem: 'a',
        author: '',
        authors_json: '[{"family":"Smith","given":"J"}]',
      }),
      mk({ stem: 'b', author: 'Other' }),
    ]
    const filtered = filterSources(sources, withFilter({ author: 'Smith' }))
    expect(filtered.map((s) => s.stem)).toEqual(['a'])
  })

  it('combines with other axes', () => {
    const sources = [
      mk({ stem: 'a', author: 'Smith', year: '2024' }),
      mk({ stem: 'b', author: 'Smith', year: '2023' }),
    ]
    const filtered = filterSources(
      sources,
      withFilter({ author: 'Smith', year: '2024' })
    )
    expect(filtered.map((s) => s.stem)).toEqual(['a'])
  })
})
