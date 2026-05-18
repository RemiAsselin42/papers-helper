import { stripBibtexBraces } from '../../utils/bibtex'

/**
 * Minimal source metadata needed to render a bibliographic reference. Both
 * `CitationHit` (search results) and `CitationRef` (stored provenance) are
 * structurally assignable to this — one formatter serves both.
 */
export interface ReferenceSource {
  stem: string
  filename: string
  title: string
  author: string
  year: string
}

/**
 * Build a bibliographic reference for a source, ready to paste into a
 * paper. Shape: `Author (Year). Title.` — each piece dropped when absent.
 */
export function formatReference(src: ReferenceSource): string {
  const title = stripBibtexBraces(src.title || src.filename || src.stem).trim()
  const lead: string[] = []
  if (src.author.trim()) lead.push(src.author.trim())
  if (src.year.trim()) lead.push(`(${src.year.trim()})`)
  const head = lead.join(' ')
  let ref = title
  if (head) {
    // Avoid a double period when the author already ends with one ("Smith, J.").
    const sep = /[.!?]$/.test(head) ? ' ' : '. '
    ref = `${head}${sep}${title}`
  }
  if (ref && !/[.!?]$/.test(ref)) ref += '.'
  return ref
}
