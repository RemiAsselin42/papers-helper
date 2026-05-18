import type { ChunkInfo } from '../../api/citations'

const _TERMINATORS = '.!?…'

/** Whether `text` ends on a sentence-terminating punctuation mark. */
function endsSentence(text: string): boolean {
  const last = text.trimEnd().slice(-1)
  return last !== '' && _TERMINATORS.includes(last)
}

export interface ContextHighlight {
  /** Text before the matched chunk — rendered muted. */
  before: string
  /** The highlighted span. */
  highlight: string
  /** Text after the highlight — rendered muted. */
  after: string
}

/**
 * Split a context window into before / highlight / after. The matched chunk
 * is highlighted in full; when the chunker cut it mid-sentence, the highlight
 * extends into the following text up to the next sentence terminator so the
 * sentence is never left half-highlighted.
 */
export function buildContextHighlight(
  chunks: ChunkInfo[],
  hitChunkIndex: number
): ContextHighlight {
  const mIdx = chunks.findIndex((c) => c.chunk_index === hitChunkIndex)
  if (mIdx === -1) {
    // Matched chunk absent from the window — shouldn't happen; highlight none.
    return { before: chunks.map((c) => c.text).join(' '), highlight: '', after: '' }
  }
  const before = chunks
    .slice(0, mIdx)
    .map((c) => c.text)
    .join(' ')
  const matched = chunks[mIdx].text
  const after = chunks
    .slice(mIdx + 1)
    .map((c) => c.text)
    .join(' ')

  // Matched chunk already ends a sentence (or nothing follows it) → no extension.
  if (after === '' || endsSentence(matched)) {
    return { before, highlight: matched, after }
  }
  // Extend through `after` up to (and including) the first sentence terminator.
  const m = /^[\s\S]*?[.!?…]/.exec(after)
  if (!m) {
    return { before, highlight: `${matched} ${after}`, after: '' }
  }
  return {
    before,
    highlight: `${matched} ${m[0]}`,
    after: after.slice(m[0].length),
  }
}
