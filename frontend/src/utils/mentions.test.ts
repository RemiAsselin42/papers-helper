import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '../api/papers'
import {
  displayType,
  findActiveMention,
  mentionInsertion,
  mentionItemCount,
  mentionSuggestions,
  parseMentions,
  resolveMentions,
} from './mentions'

function makeSource(overrides: Partial<SourceInfo>): SourceInfo {
  return {
    stem: 'stem',
    filename: 'file.pdf',
    chunk_total: 1,
    pdf_title: '',
    author: '',
    year: '',
    source_type: 'pdf',
    authors_json: '',
    publication: '',
    doi: '',
    abstract: '',
    notes: '',
    ...overrides,
  }
}

describe('findActiveMention', () => {
  it('returns null when no @ before caret', () => {
    expect(findActiveMention('hello world', 5)).toBeNull()
  })

  it('detects an active mention at start of text', () => {
    expect(findActiveMention('@Pd', 3)).toEqual({ start: 0, query: 'Pd' })
  })

  it('detects an active mention after whitespace', () => {
    expect(findActiveMention('hello @Pd', 9)).toEqual({ start: 6, query: 'Pd' })
  })

  it('ignores emails (no whitespace before @)', () => {
    expect(findActiveMention('remi@gmail.com', 14)).toBeNull()
  })

  it('cancels when whitespace appears between @ and caret', () => {
    expect(findActiveMention('@Pdf foo', 8)).toBeNull()
  })

  it('returns empty query right after typing @', () => {
    expect(findActiveMention('hello @', 7)).toEqual({ start: 6, query: '' })
  })
})

describe('parseMentions', () => {
  it('returns empty array on text without mentions', () => {
    expect(parseMentions('hello world')).toEqual([])
  })

  it('ignores emails', () => {
    expect(parseMentions('contact remi@gmail.com')).toEqual([])
  })

  it('extracts a single mention', () => {
    expect(parseMentions('see @Pdf/file.pdf')).toEqual([
      { raw: '@Pdf/file.pdf', type: 'Pdf', name: 'file.pdf' },
    ])
  })

  it('extracts multiple mentions', () => {
    const parsed = parseMentions('Compare @Pdf/a.pdf and @Docx/b.docx please')
    expect(parsed).toEqual([
      { raw: '@Pdf/a.pdf', type: 'Pdf', name: 'a.pdf' },
      { raw: '@Docx/b.docx', type: 'Docx', name: 'b.docx' },
    ])
  })

  it('allows accented characters in the filename', () => {
    const parsed = parseMentions("Voir @Pdf/L'ux-design.pdf")
    expect(parsed[0].name).toBe("L'ux-design.pdf")
  })
})

describe('resolveMentions', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'paper-a', filename: 'paper-a.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'notes-b', filename: 'notes-b.docx', source_type: 'docx' }),
  ]

  it('matches type case-insensitively', () => {
    const parsed = parseMentions('see @Pdf/paper-a.pdf')
    expect(resolveMentions(parsed, sources)).toEqual(['paper-a'])
  })

  it('returns empty when nothing matches', () => {
    const parsed = parseMentions('see @Pdf/missing.pdf')
    expect(resolveMentions(parsed, sources)).toEqual([])
  })

  it('deduplicates repeated mentions', () => {
    const parsed = parseMentions('@Pdf/paper-a.pdf again @pdf/paper-a.pdf')
    expect(resolveMentions(parsed, sources)).toEqual(['paper-a'])
  })

  it('preserves insertion order across multiple sources', () => {
    const parsed = parseMentions('@Docx/notes-b.docx and @Pdf/paper-a.pdf')
    expect(resolveMentions(parsed, sources)).toEqual(['notes-b', 'paper-a'])
  })
})

describe('displayType', () => {
  it('capitalises the first letter', () => {
    expect(displayType('pdf')).toBe('Pdf')
    expect(displayType('docx')).toBe('Docx')
  })

  it('handles empty input', () => {
    expect(displayType('')).toBe('')
  })
})

describe('mentionItemCount', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'a', filename: 'a.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'b', filename: 'b.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'c', filename: 'c.docx', source_type: 'docx' }),
  ]

  it('returns distinct type count for an empty query', () => {
    expect(mentionItemCount('', sources)).toBe(2)
  })

  it('filters types by prefix (case-insensitive)', () => {
    expect(mentionItemCount('pd', sources)).toBe(1)
    expect(mentionItemCount('PD', sources)).toBe(1)
    expect(mentionItemCount('xy', sources)).toBe(0)
  })

  it('switches to file mode once a slash is typed', () => {
    expect(mentionItemCount('Pdf/', sources)).toBe(2)
    expect(mentionItemCount('Pdf/a', sources)).toBe(1)
    expect(mentionItemCount('Pdf/z', sources)).toBe(0)
  })

  it('respects type case-insensitivity in file mode', () => {
    expect(mentionItemCount('PDF/', sources)).toBe(2)
    expect(mentionItemCount('pdf/', sources)).toBe(2)
  })
})

describe('mentionInsertion', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'a', filename: 'alpha.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'b', filename: 'beta.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'c', filename: 'gamma.docx', source_type: 'docx' }),
  ]

  it('returns a Type/ scaffold when no slash is present', () => {
    // Types are sorted alphabetically: Docx, Pdf.
    expect(mentionInsertion('', sources, 0)).toBe('Docx/')
    expect(mentionInsertion('', sources, 1)).toBe('Pdf/')
  })

  it('returns null when the index is out of range', () => {
    expect(mentionInsertion('', sources, -1)).toBeNull()
    expect(mentionInsertion('', sources, 99)).toBeNull()
    expect(mentionInsertion('Pdf/', sources, 99)).toBeNull()
  })

  it('returns Type/filename even when the user typed the type in lowercase', () => {
    // Files are sorted: alpha.pdf, beta.pdf.
    expect(mentionInsertion('pdf/', sources, 0)).toBe('Pdf/alpha.pdf')
    expect(mentionInsertion('pdf/a', sources, 0)).toBe('Pdf/alpha.pdf')
  })

  it('matches filenames by substring case-insensitively', () => {
    expect(mentionInsertion('Pdf/BETA', sources, 0)).toBe('Pdf/beta.pdf')
  })
})

describe('mentionSuggestions', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'a', filename: 'alpha.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'c', filename: 'gamma.docx', source_type: 'docx' }),
  ]

  it('lists types (without badge) when no slash present', () => {
    const items = mentionSuggestions('', sources)
    expect(items).toEqual([
      { insertion: 'Docx/', label: 'Docx' },
      { insertion: 'Pdf/', label: 'Pdf' },
    ])
    expect(items.every((s) => s.badge === undefined)).toBe(true)
  })

  it('lists files with a type badge once the slash is typed', () => {
    expect(mentionSuggestions('Pdf/', sources)).toEqual([
      { insertion: 'Pdf/alpha.pdf', label: 'alpha.pdf', badge: 'Pdf' },
    ])
  })

  it('returns an empty list when nothing matches', () => {
    expect(mentionSuggestions('xy', sources)).toEqual([])
    expect(mentionSuggestions('Pdf/zz', sources)).toEqual([])
  })

  it('stays consistent with mentionItemCount and mentionInsertion', () => {
    const query = 'Pdf/'
    const items = mentionSuggestions(query, sources)
    expect(items.length).toBe(mentionItemCount(query, sources))
    items.forEach((s, i) => {
      expect(mentionInsertion(query, sources, i)).toBe(s.insertion)
    })
  })
})
