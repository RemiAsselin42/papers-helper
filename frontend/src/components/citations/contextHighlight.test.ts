import { describe, expect, it } from 'vitest'
import type { ChunkInfo } from '../../api/citations'
import { buildContextHighlight } from './contextHighlight'

function ck(index: number, text: string): ChunkInfo {
  return { id: `c${index}`, chunk_index: index, word_count: 0, text }
}

describe('buildContextHighlight', () => {
  it('extends the highlight to finish a sentence cut by the chunk boundary', () => {
    const r = buildContextHighlight(
      [
        ck(0, 'Texte avant.'),
        ck(1, 'le développement des intranets'),
        ck(2, 'Les réunions ont eu lieu. Ensuite voilà.'),
      ],
      1
    )
    expect(r.before).toBe('Texte avant.')
    expect(r.highlight).toBe('le développement des intranets Les réunions ont eu lieu.')
    expect(r.after).toBe(' Ensuite voilà.')
  })

  it('does not extend when the matched chunk already ends a sentence', () => {
    const r = buildContextHighlight([ck(0, 'Phrase complète.'), ck(1, 'Suite du texte.')], 0)
    expect(r.highlight).toBe('Phrase complète.')
    expect(r.after).toBe('Suite du texte.')
  })

  it('highlights the whole matched chunk when nothing follows it', () => {
    const r = buildContextHighlight([ck(0, 'Avant.'), ck(1, 'fin coupée sans point')], 1)
    expect(r.highlight).toBe('fin coupée sans point')
    expect(r.after).toBe('')
  })

  it('extends through all following text when it carries no terminator', () => {
    const r = buildContextHighlight([ck(0, 'coupé ici'), ck(1, 'encore sans point')], 0)
    expect(r.highlight).toBe('coupé ici encore sans point')
    expect(r.after).toBe('')
  })

  it('highlights nothing when the matched chunk is absent', () => {
    const r = buildContextHighlight([ck(0, 'a'), ck(1, 'b')], 9)
    expect(r.highlight).toBe('')
    expect(r.before).toBe('a b')
  })
})
