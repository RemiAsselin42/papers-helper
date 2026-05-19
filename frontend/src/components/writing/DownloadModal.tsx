import { useState } from 'react'
import { Download, X } from 'lucide-react'
import { EXPORT_FORMATS, type ExportFormat } from './documentExport'
import styles from './DownloadModal.module.scss'

interface Props {
  /** Runs once per chosen format, then the modal closes. */
  onDownload: (formats: ExportFormat[]) => void
  onClose: () => void
}

/** Modal letting the user pick one or several export formats. */
export function DownloadModal({ onDownload, onClose }: Props) {
  const [selected, setSelected] = useState<Set<ExportFormat>>(new Set())

  function toggle(id: ExportFormat) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function confirm() {
    if (selected.size === 0) return
    onDownload(EXPORT_FORMATS.filter((f) => selected.has(f.id)).map((f) => f.id))
  }

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Télécharger le texte"
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h3>Télécharger le texte</h3>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <p className={styles.intro}>Choisissez un ou plusieurs formats.</p>

        <ul className={styles.formats}>
          {EXPORT_FORMATS.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className={`${styles.format} ${selected.has(f.id) ? styles.formatSelected : ''}`}
                aria-pressed={selected.has(f.id)}
                aria-label={f.label}
                onClick={() => toggle(f.id)}
              >
                <span className={styles.formatText}>
                  <span className={styles.formatLabel}>{f.label}</span>
                  <span className={styles.formatHint}>{f.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className={styles.downloadBtn}
            onClick={confirm}
            disabled={selected.size === 0}
          >
            <Download size={16} />
            Télécharger
          </button>
        </div>
      </div>
    </div>
  )
}
