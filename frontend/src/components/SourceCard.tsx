import { Check, ChevronDown, ChevronUp, Loader2, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { stripBibtexBraces } from '../utils'
import { IFRAME_PREVIEWABLE_TYPES } from '../constants/acceptedFormats'
import type { SourceInfo } from '../api/projects'
import { StatusBadge, TypeBadge } from './SourceBadges'
import { resolveType } from './SourceList.filters'
import styles from './SourceList.module.scss'

interface FileViewerProps {
  projectId: string
  source: SourceInfo
  type: string
}

function FileViewer({ projectId, source, type }: FileViewerProps) {
  const src = `/api/projects/${projectId}/papers/${encodeURIComponent(source.stem)}/file`
  const displayName = source.pdf_title || source.filename

  if (IFRAME_PREVIEWABLE_TYPES.has(type)) {
    return (
      <div className={styles.viewer}>
        <iframe src={src} className={styles.iframe} title={displayName} />
      </div>
    )
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.viewerUnsupported}>
        <p>La prévisualisation n'est pas disponible pour ce format ({type.toUpperCase()}).</p>
        <a href={src} download={source.filename} className={styles.downloadLink}>
          Télécharger le fichier
        </a>
      </div>
    </div>
  )
}

export interface SourceCardProps {
  projectId: string
  source: SourceInfo
  isOpen: boolean
  isConfirming: boolean
  isDeleting: boolean
  isReindexing: boolean
  ollamaReady: boolean
  onTogglePreview: (stem: string) => void
  onRequestConfirmDelete: (stem: string) => void
  onCancelConfirmDelete: () => void
  onConfirmDelete: (stem: string) => void
  onReindex: (stem: string) => void
  onEdit: (source: SourceInfo) => void
}

export function SourceCard({
  projectId,
  source: s,
  isOpen,
  isConfirming,
  isDeleting,
  isReindexing,
  ollamaReady,
  onTogglePreview,
  onRequestConfirmDelete,
  onCancelConfirmDelete,
  onConfirmDelete,
  onReindex,
  onEdit,
}: SourceCardProps) {
  const displayName = stripBibtexBraces(s.pdf_title || s.filename)
  const type = resolveType(s)
  const hasViewer = type !== 'url'

  return (
    <li className={styles.card}>
      <div className={styles.cardHeader}>
        <TypeBadge type={type} />
        <div className={styles.meta}>
          <span className={styles.title}>{displayName}</span>
          <div className={styles.details}>
            {s.author && <span className={styles.detail}>{stripBibtexBraces(s.author)}</span>}
            {s.author && s.year && <span className={styles.sep}>·</span>}
            {s.year && <span className={styles.detail}>{s.year}</span>}
            {(s.author || s.year) && <span className={styles.sep}>·</span>}
            <StatusBadge source={s} />
          </div>
        </div>
        <div className={styles.actions}>
          {isConfirming ? (
            <>
              <button
                className={`${styles.iconBtn} ${styles.confirmBtn}`}
                onClick={() => onConfirmDelete(s.stem)}
                disabled={isDeleting}
                aria-label="Confirmer la suppression"
                title="Confirmer"
              >
                {isDeleting ? '…' : <Check size={20} />}
              </button>
              <button
                className={styles.iconBtn}
                onClick={onCancelConfirmDelete}
                aria-label="Annuler la suppression"
                title="Annuler"
              >
                <X size={20} />
              </button>
            </>
          ) : (
            <>
              {!s.indexed && (
                <button
                  className={styles.iconBtn}
                  onClick={() => onReindex(s.stem)}
                  disabled={isReindexing || !ollamaReady}
                  aria-label={`Indexer ${s.filename}`}
                  title={
                    !ollamaReady
                      ? 'Indexation indisponible — configurer Ollama ou un fournisseur avec embeddings'
                      : isReindexing
                        ? 'Indexation en cours…'
                        : 'Indexer cette source'
                  }
                >
                  {isReindexing ? (
                    <Loader2 size={20} className={styles.spin} />
                  ) : (
                    <RefreshCw size={20} />
                  )}
                </button>
              )}
              {hasViewer && (
                <button
                  className={styles.iconBtn}
                  onClick={() => onTogglePreview(s.stem)}
                  aria-label={isOpen ? 'Fermer la prévisualisation' : 'Prévisualiser le fichier'}
                  title={isOpen ? 'Fermer' : 'Prévisualiser'}
                >
                  {isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>
              )}
              <button
                className={styles.iconBtn}
                onClick={() => onEdit(s)}
                aria-label="Modifier les métadonnées"
                title="Modifier"
              >
                <Pencil size={20} />
              </button>
              <button
                className={`${styles.iconBtn} ${styles.deleteBtn}`}
                onClick={() => onRequestConfirmDelete(s.stem)}
                aria-label={`Supprimer ${s.filename}`}
                title="Supprimer"
              >
                <Trash2 size={20} />
              </button>
            </>
          )}
        </div>
      </div>

      {isOpen && hasViewer && <FileViewer projectId={projectId} source={s} type={type} />}
    </li>
  )
}
