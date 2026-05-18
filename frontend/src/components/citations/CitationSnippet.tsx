import { useMemo } from 'react'
import { buildSnippetTokens } from './snippetHighlight'
import styles from './CitationResultCard.module.scss'

interface Props {
  text: string
  /** The query that produced the result — its words are bolded. */
  query: string
  /** Strict mode: only the contiguous word sequence is highlighted. */
  strict: boolean
  className?: string
}

/**
 * Renders a citation snippet with the searched word(s) bolded and surrounding
 * words faded by distance. Used only for the collapsed extract — the expanded
 * "more context" view shows plain text.
 */
export function CitationSnippet({ text, query, strict, className }: Props) {
  const tokens = useMemo(
    () => buildSnippetTokens(text, query, strict),
    [text, query, strict]
  )

  return (
    <p className={className}>
      {tokens.map((tok, i) => {
        if (tok.whitespace) return tok.text
        if (tok.match) {
          return (
            <strong key={i} className={styles.match} style={{ opacity: tok.opacity }}>
              {tok.text}
            </strong>
          )
        }
        return (
          <span key={i} style={{ opacity: tok.opacity }}>
            {tok.text}
          </span>
        )
      })}
    </p>
  )
}
