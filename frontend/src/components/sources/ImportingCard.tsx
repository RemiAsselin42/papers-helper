import type { FileState } from './DropZone'
import { TypeBadge } from './SourceBadges'
import { typeFromFilename } from './SourceList.filters'
import styles from './SourceList.module.scss'

export function ImportingCard({ file }: { file: FileState }) {
  const type = typeFromFilename(file.filename)
  const statusLabel =
    file.status === 'queued'
      ? 'En attente…'
      : file.status === 'processing'
        ? 'Importation en cours…'
        : file.status === 'error'
          ? file.error || 'Erreur'
          : 'Terminé'
  const variantClass =
    file.status === 'error'
      ? styles.progressError
      : file.status === 'processing'
        ? styles.progressProcessing
        : file.status === 'done'
          ? styles.progressDone
          : styles.progressQueued
  return (
    <li className={`${styles.card} ${styles.cardImporting}`}>
      <div className={styles.cardHeader}>
        <TypeBadge type={type} />
        <div className={styles.meta}>
          <span className={styles.title}>{file.filename}</span>
          <div className={styles.details}>
            <span className={styles.detail}>{statusLabel}</span>
          </div>
          <div
            className={`${styles.progressTrack} ${variantClass}`}
            role="progressbar"
            aria-label={`Import ${file.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={file.status === 'done' ? 100 : file.status === 'queued' ? 0 : undefined}
          >
            <div className={styles.progressBar} />
          </div>
        </div>
      </div>
    </li>
  )
}
