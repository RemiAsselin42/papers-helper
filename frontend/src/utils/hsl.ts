/**
 * Build a comma-separated `hsl()` string — the *legacy* CSS syntax.
 *
 * Mandatory for any colour that feeds cytoscape: cytoscape's colour parser
 * only accepts `hsl(h, s%, l%)`. The modern space-separated form silently
 * fails to parse and the element falls back to cytoscape's default grey —
 * which is why colour-by-community / category nodes once rendered all grey.
 *
 * `hue` accepts a string so callers can pre-format precision (e.g.
 * `n.toFixed(1)`); `sat` / `light` are integer percentages.
 */
export function legacyHsl(hue: number | string, sat: number, light: number): string {
  return `hsl(${hue}, ${sat}%, ${light}%)`
}
