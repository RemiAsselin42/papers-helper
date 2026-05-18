import { describe, expect, it } from 'vitest'
import { isStopWord, normalizeWord, stripStopWords } from './stopWords'

describe('normalizeWord', () => {
  it('lowercases, strips diacritics and edge punctuation', () => {
    expect(normalizeWord('Réseaux,')).toBe('reseaux')
    expect(normalizeWord('«THE»')).toBe('the')
    expect(normalizeWord('  ')).toBe('')
  })
})

describe('isStopWord', () => {
  it('recognises French and English connective words, accents aside', () => {
    expect(isStopWord('De')).toBe(true)
    expect(isStopWord('À')).toBe(true)
    expect(isStopWord('THE')).toBe(true)
    expect(isStopWord('of')).toBe(true)
    expect(isStopWord('réseaux')).toBe(false)
    expect(isStopWord('network')).toBe(false)
  })
})

describe('stripStopWords', () => {
  it('drops French connective words, keeps the important ones', () => {
    expect(stripStopWords('Les réseaux de neurones')).toBe('réseaux neurones')
  })

  it('drops English connective words', () => {
    expect(stripStopWords('the neural network of the brain')).toBe('neural network brain')
  })

  it('returns an empty string when every word is connective', () => {
    expect(stripStopWords('le la de du the of')).toBe('')
  })

  it('keeps the original casing and accents of kept words', () => {
    expect(stripStopWords('De la Théorie')).toBe('Théorie')
  })
})
