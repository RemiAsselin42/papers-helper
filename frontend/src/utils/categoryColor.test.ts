import { describe, expect, it } from 'vitest'
import { categoryColor, categoryThemeColor } from './categoryColor'

describe('categoryColor', () => {
  it('is deterministic for a given name', () => {
    expect(categoryColor('Sociologie')).toEqual(categoryColor('Sociologie'))
  })

  it('ignores leading/trailing whitespace and casing', () => {
    expect(categoryColor('  Sociologie  ').solid).toBe(categoryColor('sociologie').solid)
    expect(categoryColor('SOCIOLOGIE').solid).toBe(categoryColor('Sociologie').solid)
  })

  it('returns the four colour slots as comma-separated HSL strings', () => {
    // Comma-separated form is required: `solid` feeds cytoscape, whose colour
    // parser rejects the modern space-separated `hsl()` syntax.
    const c = categoryColor('Méthodes')
    for (const v of [c.bg, c.fg, c.border, c.solid]) {
      expect(v).toMatch(/^hsl\(\d+,\s\d+%,\s\d+%\)$/)
    }
  })

  it('produces distinct hues for a small fixture of unrelated names', () => {
    const names = ['Sociologie', 'Méthodes', 'Statistiques', 'Éducation', 'Économie']
    const hues = new Set(names.map((n) => categoryColor(n).solid))
    // No hard uniqueness guarantee, but 5 distinct strings out of 5 is what we
    // expect for a sensible hash distribution; if this ever flakes the hash is
    // probably broken.
    expect(hues.size).toBe(names.length)
  })

  it('exposes the solid colour via the shorthand', () => {
    expect(categoryThemeColor('Sociologie')).toBe(categoryColor('Sociologie').solid)
  })
})
