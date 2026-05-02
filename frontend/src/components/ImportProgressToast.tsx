import { Loader2, Check, X, Clock } from 'lucide-react'
import type { FileState } from './DropZone'
import styles from './ImportProgressToast.module.scss'

interface ImportProgressToastProps {
  fileStates: FileState[]
  onDismiss: () => void
}

export function ImportProgressToast({ fileStates, onDismiss }: ImportProgressToastProps) {
  if (fileStates.length === 0) return null

  const allSettled = fileStates.every((f) => f.status === 'done' || f.status === 'error')

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
        {fileStates.map((f) => (
          <li key={f.filename} className={`${styles.item} ${styles[`status_${f.status}`]}`}>
            <span className={styles.icon}>
              {f.status === 'queued' && <Clock size={16} />}
              {f.status === 'processing' && <Loader2 size={16} className={styles.spin} />}
              {f.status === 'done' && <Check size={16} />}
              {f.status === 'error' && <X size={16} />}
            </span>
            <span className={styles.name}>{f.filename}</span>
            {f.status === 'done' && <span className={styles.meta}>{f.chunks} chunks</span>}
            {f.status === 'error' && <span className={styles.meta}>{f.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
