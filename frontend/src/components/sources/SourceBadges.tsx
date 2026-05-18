import { FileText, Link } from 'lucide-react'
import { typeBadgeClass } from '../../utils/typeBadgeClass'
import type { SourceInfo } from '../../api/papers'
import { FORMAT_LABEL } from './SourceList.filters'
import styles from './SourceList.module.scss'

export function TypeBadge({ type }: { type: string }) {
  const colorClass = typeBadgeClass(type, styles) ?? styles.badgeFallback
  const cls = `${styles.badge} ${colorClass ?? ''}`.trim()
  if (type === 'url')
    return (
      <span className={cls}>
        <Link size={20} /> URL
      </span>
    )
  return (
    <span className={cls}>
      <FileText size={20} /> {FORMAT_LABEL[type] ?? type.toUpperCase()}
    </span>
  )
}

export function StatusBadge({ source }: { source: SourceInfo }) {
  if (source.indexed) {
    return <span className={styles.badgeIndexed}>Indexé</span>
  }
  // A non-indexed source that carries an error genuinely *failed* — show it as
  // such (distinct from a source simply not indexed yet). The full message is
  // also rendered inline on the card (see SourceCard), so it stays visible
  // even where native `title` tooltips don't (Firefox).
  if (source.index_error) {
    return (
      <span className={styles.badgeError} title={source.index_error}>
        Échec indexation
      </span>
    )
  }
  return (
    <span
      className={styles.badgeWarning}
      title="Non indexé — relancer pour activer la recherche sémantique"
    >
      Non indexé
    </span>
  )
}
