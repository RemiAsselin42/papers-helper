import { useRef, useState } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { searchCitations, type CitationHit } from '../../api/citations'
import { formatReference } from '../citations/citationReference'
import styles from './CitationPicker.module.scss'

interface Props {
  projectId: string
  onPick: (hit: CitationHit) => void
  onClose: () => void
}

/**
 * Modal that runs the existing semantic citation search and lets the user pick
 * a hit to insert into the section. No new backend surface — it reuses
 * `POST /projects/{id}/citations/search`.
 */
export function CitationPicker({ projectId, onPick, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CitationHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const hits = await searchCitations(projectId, q, {}, 20, false, ctrl.signal)
      setResults(hits)
      setSearched(true)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Erreur de recherche')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Insérer une citation"
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>Insérer une citation</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <form className={styles.searchRow} onSubmit={runSearch}>
          <input
            type="text"
            className={styles.input}
            placeholder="Rechercher dans les sources du projet…"
            aria-label="Rechercher une citation"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className={styles.searchBtn} disabled={loading || !query.trim()}>
            {loading ? <Loader2 size={16} className={styles.spin} /> : <Search size={16} />}
            Rechercher
          </button>
        </form>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.results}>
          {searched && !loading && results.length === 0 && !error && (
            <p className={styles.empty}>Aucune source indexée ne correspond à cette recherche.</p>
          )}
          {results.map((hit) => (
            <button
              key={hit.chunk_id}
              type="button"
              className={styles.hit}
              onClick={() => onPick(hit)}
            >
              <span className={styles.ref}>{formatReference(hit)}</span>
              <span className={styles.snippet}>{hit.text.slice(0, 220)}…</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
