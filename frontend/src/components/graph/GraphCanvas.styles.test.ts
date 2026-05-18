import { describe, expect, it } from 'vitest'
import { communityColor } from './GraphCanvas.styles'

/**
 * Parse `hsl(H, S%, L%)` into its three numeric channels — and double as the
 * cytoscape-compatibility gate: cytoscape's colour parser only accepts the
 * legacy *comma-separated* `hsl()` syntax. The modern space-separated form
 * silently fails to parse and the node renders as cytoscape's default grey.
 */
function parseHsl(value: string): { h: number; s: number; l: number } {
  const m = value.match(/^hsl\(([\d.]+),\s(\d+)%,\s(\d+)%\)$/)
  if (!m) throw new Error(`not a comma-separated (cytoscape-parseable) HSL string: ${value}`)
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) }
}

/** Circular distance between two hues, in degrees (0-180). */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

describe('communityColor', () => {
  it('is deterministic and emits cytoscape-parseable comma-separated HSL', () => {
    for (let i = 0; i < 20; i++) {
      expect(communityColor(i)).toBe(communityColor(i))
      // Comma-separated form — the space-separated syntax renders grey.
      expect(communityColor(i)).toMatch(/^hsl\([\d.]+,\s\d+%,\s\d+%\)$/)
    }
  })

  it('clamps negative / fractional indices', () => {
    expect(communityColor(-3)).toBe(communityColor(0))
    expect(communityColor(2.7)).toBe(communityColor(2))
  })

  // Regression: with golden-angle hue rotation at a *fixed* saturation and
  // lightness, communities 0 & 13 (and a dozen other pairs) landed only
  // ~12-20° apart on the wheel and rendered as the same colour — a lone
  // cluster looked identical to an unrelated connected one. Every near-hue
  // pair must now differ in a second channel (saturation or lightness).
  it('keeps near-hue communities distinguishable by a second channel', () => {
    const colors = Array.from({ length: 20 }, (_, i) => parseHsl(communityColor(i)))
    for (let a = 0; a < colors.length; a++) {
      for (let b = a + 1; b < colors.length; b++) {
        if (hueGap(colors[a].h, colors[b].h) < 24) {
          const lDiff = Math.abs(colors[a].l - colors[b].l)
          const sDiff = Math.abs(colors[a].s - colors[b].s)
          expect(
            lDiff >= 6 || sDiff >= 10,
            `communities ${a} and ${b} share a hue band without a second-channel difference`
          ).toBe(true)
        }
      }
    }
  })
})
