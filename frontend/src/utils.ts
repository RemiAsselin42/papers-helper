export function stripBibtexBraces(s: string): string {
  return s.replace(/[{}]/g, '')
}
