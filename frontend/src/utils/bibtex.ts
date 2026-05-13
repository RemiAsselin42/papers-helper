export function stripBibtexBraces(s: string): string {
  return s.replace(/[{}]/g, '')
}

export function extractBibtexCategories(s: string): string[] {
  const matches = s.match(/\{([^{}]+)\}/g)
  if (!matches) return []
  return [...new Set(matches.map((m) => m.slice(1, -1).trim()).filter(Boolean))]
}
