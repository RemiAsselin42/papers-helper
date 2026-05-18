import type { CitationHit } from '../../api/citations'
import { stripBibtexBraces } from '../../utils/bibtex'

/**
 * Build a bibliographic reference for a hit's source, ready to paste into a
 * paper. Shape: `Author (Year). Title.` — each piece dropped when absent.
 */
export function formatReference(hit: CitationHit): string {
  const title = stripBibtexBraces(hit.title || hit.filename || hit.stem).trim()
  const lead: string[] = []
  if (hit.author.trim()) lead.push(hit.author.trim())
  if (hit.year.trim()) lead.push(`(${hit.year.trim()})`)
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
