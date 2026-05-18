import { describe, expect, it } from 'vitest'
import { mergeCategories, parseLlmStringArray, splitCategoriesCsv } from './categories'

describe('splitCategoriesCsv', () => {
  it('returns an empty array for the empty string', () => {
    expect(splitCategoriesCsv('')).toEqual([])
  })

  it('splits on commas and semicolons interchangeably', () => {
    expect(splitCategoriesCsv('A, B ; C,D')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('trims, drops empties, and dedups case-insensitively keeping first casing', () => {
    expect(splitCategoriesCsv('Sociologie, sociologie, Méthodes ,, ')).toEqual([
      'Sociologie',
      'Méthodes',
    ])
  })
})

describe('mergeCategories', () => {
  it('returns first-seen casing when the same name appears in different cases', () => {
    expect(mergeCategories(['Sociologie'], ['sociologie'])).toEqual(['Sociologie'])
  })

  it('preserves order across lists', () => {
    expect(mergeCategories(['A', 'B'], ['C', 'B', 'D'])).toEqual(['A', 'B', 'C', 'D'])
  })

  it('skips empty entries', () => {
    expect(mergeCategories(['', '  '], ['X'])).toEqual(['X'])
  })
})

describe('parseLlmStringArray', () => {
  it('parses a plain JSON array', () => {
    expect(parseLlmStringArray('["A", "B", "C"]')).toEqual(['A', 'B', 'C'])
  })

  it('strips a leading ```json code fence', () => {
    expect(parseLlmStringArray('```json\n["X","Y"]\n```')).toEqual(['X', 'Y'])
  })

  it('locates the array even when surrounded by prose', () => {
    expect(parseLlmStringArray('Voici la réponse : ["Foo","Bar"]. Voilà.')).toEqual(['Foo', 'Bar'])
  })

  it('dedupes case-insensitively', () => {
    expect(parseLlmStringArray('["A","a","B"]')).toEqual(['A', 'B'])
  })

  it('returns [] when the JSON is malformed', () => {
    expect(parseLlmStringArray('not json at all')).toEqual([])
    expect(parseLlmStringArray('[not, valid]')).toEqual([])
  })

  it('caps the result at the requested max', () => {
    expect(parseLlmStringArray('["a","b","c","d","e","f"]', 3)).toEqual(['a', 'b', 'c'])
  })

  it('skips non-string entries', () => {
    expect(parseLlmStringArray('["A", 42, null, "B"]')).toEqual(['A', 'B'])
  })

  it('recovers from curly quotes', () => {
    expect(parseLlmStringArray('[“Utilisabilité”, “Web design”]')).toEqual([
      'Utilisabilité',
      'Web design',
    ])
  })

  it('recovers from trailing commas', () => {
    expect(parseLlmStringArray('["A", "B", "C",]')).toEqual(['A', 'B', 'C'])
  })

  it('falls back to a numbered list when no JSON is present', () => {
    const raw = `Voici les catégories :
1. Utilisabilité
2. Web design
3. Méthodes de conception`
    expect(parseLlmStringArray(raw)).toEqual([
      'Utilisabilité',
      'Web design',
      'Méthodes de conception',
    ])
  })

  it('falls back to a bullet list', () => {
    expect(parseLlmStringArray('- Foo\n* Bar\n• Baz')).toEqual(['Foo', 'Bar', 'Baz'])
  })

  it('ignores plain prose lines without list markers', () => {
    // No bullets, no numbering, no wrapping quotes — should yield nothing.
    expect(parseLlmStringArray('Voici une réponse.\nMerci de votre attention.')).toEqual([])
  })

  it('drops overly long candidate lines from the line-based fallback', () => {
    const longLine = '- ' + 'x'.repeat(120)
    expect(parseLlmStringArray(`${longLine}\n- Court`)).toEqual(['Court'])
  })

  it('strips trailing JSON-array artefacts (`"]`) from scraped category lines', () => {
    // A broken array the JSON parser rejects falls to the line scraper; the
    // last element carries a stray `"]` that must not glue to the label.
    expect(parseLlmStringArray('- "Sociologie"\n- "Éducation"]')).toEqual([
      'Sociologie',
      'Éducation',
    ])
  })

  it('strips a trailing `"}` artefact from a scraped category line', () => {
    expect(parseLlmStringArray('1. Web design\n2. Méthodes"}')).toEqual([
      'Web design',
      'Méthodes',
    ])
  })
})
