import { Loader2, Check, X, Clock, Sparkles, Database } from 'lucide-react'
import type { FileState } from './DropZone'
import type { EnrichState } from '../../hooks/useAutoEnrich'
import type { IndexState } from '../../hooks/useIndexingPass'
import styles from './ImportProgressToast.module.scss'

interface ImportProgressToastProps {
  fileStates: FileState[]
  /** Stem-keyed indexing-pass states (Stage 2). Keyed by stem — not filename
   * — so URL imports (whose toast row carries the URL as `filename`) still
   * correlate with their indexing/enrichment progress. */
  indexStates?: Record<string, IndexState>
  /** Stem-keyed auto-enrichment states (Stage 3). A row is considered settled
   * only when its import, indexing AND enrichment phases have all resolved. */
  enrichStates?: Record<string, EnrichState>
  onDismiss: () => void
}

type BadgeVariant = 'pending' | 'running' | 'done' | 'error'
interface Badge {
  text: string
  variant: BadgeVariant
  spin: boolean
}

function indexLabel(state: IndexState | undefined): Badge | null {
  if (!state) return null
  switch (state.phase) {
    case 'queued':
      return { text: 'Indexation en file…', variant: 'pending', spin: false }
    case 'indexing':
      return { text: 'Indexation…', variant: 'running', spin: true }
    case 'failed':
      return { text: 'Échec indexation', variant: 'error', spin: false }
    case 'indexed':
      // No badge: the enrichment badge takes over once indexing succeeds.
      return null
  }
}

function enrichLabel(state: EnrichState | undefined): Badge | null {
  if (!state) return null
  switch (state.phase) {
    case 'pending':
      // No spinner: pending means queued but not yet started. The spinner is
      // reserved for actually-running generations so the user can tell at a
      // glance which source is being worked on.
      return { text: 'IA en file…', variant: 'pending', spin: false }
    case 'abstract':
      return { text: 'Résumé IA…', variant: 'running', spin: true }
    case 'categories':
      return { text: 'Catégories IA…', variant: 'running', spin: true }
    case 'done':
      return { text: 'Enrichi', variant: 'done', spin: false }
    case 'error':
      return { text: 'Échec IA', variant: 'error', spin: false }
    case 'skipped':
      return null
  }
}

export function ImportProgressToast({
  fileStates,
  indexStates,
  enrichStates,
  onDismiss,
}: ImportProgressToastProps) {
  if (fileStates.length === 0) return null

  const allSettled = fileStates.every((f) => {
    if (f.status === 'queued' || f.status === 'processing') return false
    if (f.status === 'error') return true
    // status === 'done' — also wait for the indexing + enrichment phases.
    const idx = f.stem ? indexStates?.[f.stem] : undefined
    if (idx && (idx.phase === 'queued' || idx.phase === 'indexing')) return false
    if (!f.stem) return true
    const enrich = enrichStates?.[f.stem]
    if (!enrich) return true
    return enrich.phase === 'done' || enrich.phase === 'skipped' || enrich.phase === 'error'
  })

  return (
    <div className={styles.toast}>
      <div className={styles.header}>
        <span className={styles.title}>Importation</span>
        {allSettled && (
          <button className={styles.dismiss} onClick={onDismiss} aria-label="Fermer">
            <X size={20} />
          </button>
        )}
      </div>
      <ul className={styles.list}>
        {fileStates.map((f) => {
          const isDoc =
            f.status === 'done' &&
            f.extracted_count === undefined &&
            f.items_parsed === undefined
          const idx = f.stem ? indexStates?.[f.stem] : undefined
          const indexBadge = isDoc ? indexLabel(idx) : null
          const enrich = f.stem ? enrichStates?.[f.stem] : undefined
          const enrichBadge = isDoc && idx?.phase === 'indexed' ? enrichLabel(enrich) : null
          // A reindex row is seeded with status 'done' (the file was already
          // imported); it must read as in-progress until its index pass
          // resolves — a spinner, not the green "imported" check.
          const reindexPending =
            f.reindexing === true && idx?.phase !== 'indexed' && idx?.phase !== 'failed'
          return (
            <li
              key={f.filename}
              className={`${styles.item} ${styles[`status_${f.status}`]} ${
                reindexPending ? styles.reindexing : ''
              }`}
            >
              <span className={styles.icon}>
                {f.status === 'queued' && <Clock size={16} />}
                {f.status === 'processing' && <Loader2 size={16} className={styles.spin} />}
                {f.status === 'done' &&
                  (reindexPending ? (
                    <Loader2 size={16} className={styles.spin} />
                  ) : (
                    <Check size={16} />
                  ))}
                {f.status === 'error' && <X size={16} />}
              </span>
              <span className={styles.name}>{f.filename}</span>
              {f.status === 'done' && !f.reindexing && (
                <span className={styles.meta}>
                  {f.extracted_count !== undefined
                    ? `${f.extracted_count} fichier${f.extracted_count !== 1 ? 's' : ''} extrait${f.extracted_count !== 1 ? 's' : ''}`
                    : f.items_parsed !== undefined
                      ? `${f.items_parsed} référence${f.items_parsed !== 1 ? 's' : ''}`
                      : 'importé'}
                </span>
              )}
              {f.status === 'error' && <span className={styles.meta}>{f.error}</span>}
              {indexBadge && (
                <span
                  className={`${styles.enrich} ${styles[`enrich_${indexBadge.variant}`]}`}
                  title={idx?.error || undefined}
                >
                  <Database size={12} className={indexBadge.spin ? styles.spin : undefined} />
                  {indexBadge.text}
                </span>
              )}
              {enrichBadge && (
                <span
                  className={`${styles.enrich} ${styles[`enrich_${enrichBadge.variant}`]}`}
                  title={enrich?.error || undefined}
                >
                  {enrichBadge.variant === 'pending' ? (
                    <Clock size={12} />
                  ) : (
                    <Sparkles size={12} className={enrichBadge.spin ? styles.spin : undefined} />
                  )}
                  {enrichBadge.text}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
