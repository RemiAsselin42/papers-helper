import { describe, expect, it } from 'vitest'
import { buildSnippetTokens, hasStrictMatch } from './snippetHighlight'

/** Word tokens only (whitespace tokens dropped). */
function words(text: string, query: string, strict = false) {
  return buildSnippetTokens(text, query, strict).filter((t) => !t.whitespace)
}

describe('buildSnippetTokens', () => {
  it('bolds the match and keeps the 4 nearest words on each side fully opaque', () => {
    const text = Array.from({ length: 30 }, (_, i) => (i === 0 ? 'cible' : `w${i}`)).join(' ')
    const w = words(text, 'cible')

    expect(w[0].match).toBe(true)
    expect(w[0].opacity).toBe(1)
    expect(w[4].opacity).toBe(1) // distance 4 — still full
  })

  it('fades from the 5th word and bottoms out at the 0.15 floor', () => {
    const text = Array.from({ length: 30 }, (_, i) => (i === 0 ? 'cible' : `w${i}`)).join(' ')
    const w = words(text, 'cible')

    expect(w[5].opacity).toBeLessThan(1) // distance 5 — fade starts
    expect(w[5].opacity).toBeGreaterThan(0.15)
    expect(w[25].opacity).toBeCloseTo(0.15) // far word clamped to the floor
    expect(w[25].match).toBe(false)
  })

  it('uses the nearest occurrence when the word appears several times', () => {
    const parts = Array.from({ length: 25 }, (_, i) =>
      i === 0 || i === 20 ? 'cible' : `w${i}`
    )
    const w = words(parts.join(' '), 'cible')

    // index 19 is 1 away from the second occurrence → full opacity, despite
    // being 19 words from the first.
    expect(w[19].opacity).toBe(1)
    expect(w[0].match).toBe(true)
    expect(w[20].match).toBe(true)
  })

  it('returns every word fully opaque when nothing matches', () => {
    const w = words('alpha beta gamma delta', 'zzz')
    expect(w.every((t) => t.opacity === 1 && !t.match)).toBe(true)
  })

  it('treats an empty query as no match', () => {
    const w = words('alpha beta gamma', '   ')
    expect(w.every((t) => t.opacity === 1 && !t.match)).toBe(true)
  })

  it('matches case-, accent- and punctuation-insensitively', () => {
    const w = words('Les Réseaux, de neurones', 'reseaux')
    expect(w[1].text).toBe('Réseaux,') // original text preserved
    expect(w[1].match).toBe(true)
  })

  it('preserves the original text exactly (whitespace included)', () => {
    const text = 'un deux\n\ttrois   quatre'
    const rebuilt = buildSnippetTokens(text, 'deux')
      .map((t) => t.text)
      .join('')
    expect(rebuilt).toBe(text)
  })

  it('ignores query tokens shorter than 2 characters', () => {
    const w = words('a la maison a la campagne', 'a')
    expect(w.some((t) => t.match)).toBe(false)
  })

  it('never highlights connective words from the query (token mode)', () => {
    const w = words('le réseau de neurones est complexe', 'le réseau de neurones')
    expect(w[0].match).toBe(false) // "le"
    expect(w[1].match).toBe(true) // "réseau"
    expect(w[2].match).toBe(false) // "de"
    expect(w[3].match).toBe(true) // "neurones"
  })

  it('strict mode highlights only the contiguous word sequence', () => {
    const w = words('les réseaux de neurones et d autres réseaux profonds', 'réseaux de neurones', true)
    expect([w[1].match, w[2].match, w[3].match]).toEqual([true, true, true])
    // a lone "réseaux" outside the contiguous run stays unhighlighted
    expect(w[7].text).toBe('réseaux')
    expect(w[7].match).toBe(false)
  })

  it('strict mode highlights nothing when the sequence is not contiguous', () => {
    const w = words('réseaux profonds et neurones', 'réseaux neurones', true)
    expect(w.some((t) => t.match)).toBe(false)
  })
})

describe('hasStrictMatch', () => {
  it('is true when the exact contiguous sequence occurs', () => {
    expect(hasStrictMatch('les réseaux de neurones profonds', 'réseaux de neurones')).toBe(true)
  })

  it('is false when the words occur but not contiguously', () => {
    expect(hasStrictMatch('réseaux profonds et neurones', 'réseaux neurones')).toBe(false)
  })

  it('is false when a word of the phrase is missing', () => {
    expect(hasStrictMatch('les arbres de décision', 'réseaux de neurones')).toBe(false)
  })
})
