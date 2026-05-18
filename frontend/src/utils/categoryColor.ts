/**
 * Deterministic per-category color. The hash is FNV-1a 32-bit on the
 * trimmed lowercased name, mapped to a fixed-saturation/lightness HSL
 * triplet. The same name always yields the same color across the modal
 * pills, the filter dropdown swatch, and the graph category nodes.
 *
 * `bg/fg/border` are tuned for pills on a light surface (soft tinted
 * background, deep text, mid border). `solid` is the saturated fill used
 * for cytoscape category nodes on the cream graph canvas.
 */

import { legacyHsl } from './hsl'

function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export interface CategoryColors {
  bg: string
  fg: string
  border: string
  solid: string
}

export function categoryColor(name: string): CategoryColors {
  const key = name.trim().toLowerCase()
  const hue = fnv1a32(key) % 360
  // `legacyHsl` emits the comma-separated form: `solid` feeds cytoscape via
  // `categoryThemeColor`, whose colour parser rejects the modern
  // space-separated `hsl()` syntax and falls back to grey.
  return {
    bg: legacyHsl(hue, 65, 92),
    fg: legacyHsl(hue, 60, 28),
    border: legacyHsl(hue, 55, 70),
    solid: legacyHsl(hue, 65, 55),
  }
}

export function categoryThemeColor(name: string): string {
  return categoryColor(name).solid
}
