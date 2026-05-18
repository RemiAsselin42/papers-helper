import { Copy, Check, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { getCitationContext, type ChunkInfo, type CitationHit } from '../../api/citations'
import { CitationSnippet } from './CitationSnippet'
import { buildContextHighlight } from './contextHighlight'
import { formatReference } from './citationReference'
import styles from './CitationResultCard.module.scss'

interface Props {
  hit: CitationHit
  projectId: string
  /** The query that produced this hit — its words are highlighted in the snippet. */
  query: string
  /** Strict mode: highlight only the contiguous word sequence. */
  strict: boolean
  /** Opens the Sources view filtered onto this hit's source paper. */
  onOpenSource: (stem: string, title: string) => void
}

export function CitationResultCard({ hit, projectId, query, strict, onOpenSource }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [context, setContext] = useState<ChunkInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)

  const sourceLabel = hit.title || hit.filename || hit.stem
  const percent = Math.round(hit.similarity * 100)
  const ctxHl = context ? buildContextHighlight(context, hit.chunk_index) : null

  async function copyReference() {
    try {
      await navigator.clipboard.writeText(formatReference(hit))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  }

  async function toggleContext() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    // Fetch once, then keep the result cached across collapse/expand cycles.
    if (context || loading) return
    setLoading(true)
    setError(false)
    try {
      setContext(await getCitationContext(projectId, hit.stem, hit.chunk_index))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <article className={styles.card}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.sourceLink}
          onClick={() => onOpenSource(hit.stem, sourceLabel)}
          title="Ouvrir la source"
        >
          <span className={styles.sourceTitle}>{sourceLabel}</span>
          <ExternalLink size={18} className={styles.externalLink} aria-hidden="true" />
        </button>
        <div className={styles.meta}>
          {hit.author && <span className={styles.metaItem}>{hit.author}</span>}
          {hit.year && <span className={styles.metaItem}>{hit.year}</span>}
          <span className={styles.score} title="Similarité sémantique">
            {percent}%
          </span>
          <button
            type="button"
            className={`${styles.copyBtn} ${copied ? styles.copyBtnDone : ''}`}
            onClick={copyReference}
            aria-label="Copier la référence de la source"
            title={copied ? 'Référence copiée' : 'Copier la référence'}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </header>

      {expanded && ctxHl ? (
        // One continuous block: the matched chunk highlighted inline, its cut
        // sentence completed into the neighbouring text (see contextHighlight).
        <p className={styles.context}>
          {ctxHl.before}
          {ctxHl.before && ' '}
          <span className={styles.contextHit}>{ctxHl.highlight}</span>
          {ctxHl.after && ' '}
          {ctxHl.after}
        </p>
      ) : expanded ? (
        // Context still loading — plain text, no highlight effect.
        <p className={styles.snippet}>{hit.text}</p>
      ) : (
        <CitationSnippet text={hit.text} query={query} strict={strict} className={styles.snippet} />
      )}

      {expanded && loading && <p className={styles.hint}>Chargement du contexte…</p>}
      {expanded && error && <p className={styles.errorText}>Impossible de charger le contexte.</p>}

      <footer className={styles.footer}>
        <span className={styles.position}>
          Extrait {hit.chunk_index + 1}
          {hit.chunk_total ? ` / ${hit.chunk_total}` : ''}
        </span>
        <button type="button" className={styles.contextBtn} onClick={toggleContext}>
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          {expanded ? 'Réduire' : 'Voir plus de contexte'}
        </button>
      </footer>
    </article>
  )
}
