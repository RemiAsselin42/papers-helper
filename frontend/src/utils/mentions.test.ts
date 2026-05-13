import { describe, expect, it } from 'vitest'
import type { SourceInfo } from '../api/papers'
import {
  detoxMentions,
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
    indexed: true,
    index_error: '',
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
  const sources: SourceInfo[] = [
    makeSource({ stem: 'file', filename: 'file.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'a', filename: 'a.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'b', filename: 'b.docx', source_type: 'docx' }),
    makeSource({
      stem: 'l-ux-design',
      filename: "L'ux-design.pdf",
      source_type: 'pdf',
    }),
    makeSource({
      stem: 'baltes-dashuber-2021',
      filename: 'Baltes et Dashuber - 2021 - UX Debt.pdf',
      source_type: 'pdf',
    }),
    makeSource({
      stem: 'foo',
      filename: 'foo',
      source_type: 'pdf',
    }),
    makeSource({
      stem: 'foo-pdf',
      filename: 'foo.pdf',
      source_type: 'pdf',
    }),
  ]

  it('returns empty array on text without mentions', () => {
    expect(parseMentions('hello world', sources)).toEqual([])
  })

  it('ignores emails', () => {
    expect(parseMentions('contact remi@gmail.com', sources)).toEqual([])
  })

  it('extracts a single mention', () => {
    expect(parseMentions('see @Pdf/file.pdf', sources)).toEqual([
      { raw: '@Pdf/file.pdf', type: 'Pdf', name: 'file.pdf' },
    ])
  })

  it('extracts multiple mentions', () => {
    const parsed = parseMentions('Compare @Pdf/a.pdf and @Docx/b.docx please', sources)
    expect(parsed).toEqual([
      { raw: '@Pdf/a.pdf', type: 'Pdf', name: 'a.pdf' },
      { raw: '@Docx/b.docx', type: 'Docx', name: 'b.docx' },
    ])
  })

  it('allows accented characters in the filename', () => {
    const parsed = parseMentions("Voir @Pdf/L'ux-design.pdf", sources)
    expect(parsed[0].name).toBe("L'ux-design.pdf")
  })

  it('matches filenames containing spaces via longest-prefix lookup', () => {
    const parsed = parseMentions(
      'résume @Pdf/Baltes et Dashuber - 2021 - UX Debt.pdf stp',
      sources
    )
    expect(parsed).toEqual([
      {
        raw: '@Pdf/Baltes et Dashuber - 2021 - UX Debt.pdf',
        type: 'Pdf',
        name: 'Baltes et Dashuber - 2021 - UX Debt.pdf',
      },
    ])
  })

  it('prefers the longest matching filename when several share a prefix', () => {
    // `foo` and `foo.pdf` are both registered; the parser must pick `foo.pdf`.
    const parsed = parseMentions('voir @Pdf/foo.pdf maintenant', sources)
    expect(parsed[0].name).toBe('foo.pdf')
  })

  it('skips occurrences that resolve to no known source', () => {
    expect(parseMentions('see @Pdf/missing.pdf', sources)).toEqual([])
  })

  it('skips when the type does not match any source', () => {
    expect(parseMentions('see @Bogus/file.pdf', sources)).toEqual([])
  })
})

describe('detoxMentions', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'a', filename: 'a.pdf', source_type: 'pdf' }),
    makeSource({
      stem: 'baltes',
      filename: 'Baltes et Dashuber - 2021 - UX Debt.pdf',
      source_type: 'pdf',
    }),
  ]

  it('replaces a single @-token with the quoted filename', () => {
    const text = 'résume @Pdf/a.pdf'
    const parsed = parseMentions(text, sources)
    expect(detoxMentions(text, parsed)).toBe('résume « a.pdf »')
  })

  it('handles filenames with spaces', () => {
    const text = 'résume @Pdf/Baltes et Dashuber - 2021 - UX Debt.pdf stp'
    const parsed = parseMentions(text, sources)
    expect(detoxMentions(text, parsed)).toBe(
      'résume « Baltes et Dashuber - 2021 - UX Debt.pdf » stp'
    )
  })

  it('is a no-op when no mentions resolved', () => {
    expect(detoxMentions('hello @Pdf/missing.pdf', [])).toBe('hello @Pdf/missing.pdf')
  })

  it('replaces longest first so a shorter prefix mention cannot mangle a longer one', () => {
    // Hand-craft an input where two parsed mentions share a prefix. The
    // longest one MUST be replaced first, otherwise replacing `@Pdf/foo.pdf`
    // would chop the `@Pdf/foo.pdf.backup` mention into `« foo.pdf ».backup`.
    const parsed = [
      { raw: '@Pdf/foo.pdf', type: 'Pdf', name: 'foo.pdf' },
      { raw: '@Pdf/foo.pdf.backup', type: 'Pdf', name: 'foo.pdf.backup' },
    ]
    const text = 'use @Pdf/foo.pdf or @Pdf/foo.pdf.backup'
    expect(detoxMentions(text, parsed)).toBe('use « foo.pdf » or « foo.pdf.backup »')
  })
})

describe('resolveMentions', () => {
  const sources: SourceInfo[] = [
    makeSource({ stem: 'paper-a', filename: 'paper-a.pdf', source_type: 'pdf' }),
    makeSource({ stem: 'notes-b', filename: 'notes-b.docx', source_type: 'docx' }),
  ]

  it('matches type case-insensitively', () => {
    const parsed = parseMentions('see @Pdf/paper-a.pdf', sources)
    expect(resolveMentions(parsed, sources)).toEqual(['paper-a'])
  })

  it('returns empty when nothing matches', () => {
    const parsed = parseMentions('see @Pdf/missing.pdf', sources)
    expect(resolveMentions(parsed, sources)).toEqual([])
  })

  it('deduplicates repeated mentions', () => {
    const parsed = parseMentions('@Pdf/paper-a.pdf again @pdf/paper-a.pdf', sources)
    expect(resolveMentions(parsed, sources)).toEqual(['paper-a'])
  })

  it('preserves insertion order across multiple sources', () => {
    const parsed = parseMentions('@Docx/notes-b.docx and @Pdf/paper-a.pdf', sources)
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
