import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  Link,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { deleteSource, listSources, type SourceInfo } from '../api/projects'
import { EXT_TO_TYPE, IFRAME_PREVIEWABLE_TYPES } from '../constants/acceptedFormats'
import { MetadataModal } from './MetadataModal'
import styles from './SourceList.module.scss'

interface SourceListProps {
  projectId: string
  refreshKey?: number
  onDelete?: () => void
}

const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  odt: 'ODT',
  rtf: 'RTF',
  html: 'HTML',
  epub: 'EPUB',
  url: 'URL',
}

/**
 * Derive the canonical type from the filename extension.
 * source_type from the API can be stale/wrong; the filename extension is stable.
 * Falls back to source_type for url which has no meaningful file extension.
 */
function resolveType(source: SourceInfo): string {
  if (source.source_type === 'url') return 'url'
  const ext = source.filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_TYPE[ext] ?? source.source_type
}

function TypeBadge({ type }: { type: string }) {
  if (type === 'url')
    return (
      <span className={styles.badgeUrl}>
        <Link size={20} /> URL
      </span>
    )
  return (
    <span className={styles.badgeDoc}>
      <FileText size={20} /> {FORMAT_LABEL[type] ?? type.toUpperCase()}
    </span>
  )
}

function StatusBadge({ source }: { source: SourceInfo }) {
  if (source.chunk_total > 0) {
    return <span className={styles.badgeIndexed}>Indexé</span>
  }
  return <span className={styles.badgeError}>Non indexé</span>
}

function FileViewer({
  projectId,
  source,
  type,
}: {
  projectId: string
  source: SourceInfo
  type: string
}) {
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

export function SourceList({ projectId, refreshKey, onDelete }: SourceListProps) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [confirmStem, setConfirmStem] = useState<string | null>(null)
  const [deletingStem, setDeletingStem] = useState<string | null>(null)
  const [editingSource, setEditingSource] = useState<SourceInfo | null>(null)
  const [openStem, setOpenStem] = useState<string | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)

  const fetchSources = useCallback(async () => {
    try {
      const data = await listSources(projectId)
      setSources(data)
      setNetworkError(null)
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'Erreur réseau')
    }
  }, [projectId])

  useEffect(() => {
    fetchSources()
  }, [refreshKey, fetchSources])

  async function handleConfirmDelete(stem: string) {
    setDeletingStem(stem)
    try {
      await deleteSource(projectId, stem)
      setSources((s) => s.filter((x) => x.stem !== stem))
      if (openStem === stem) setOpenStem(null)
      onDelete?.()
    } finally {
      setDeletingStem(null)
      setConfirmStem(null)
    }
  }

  function handleSaved(updated: SourceInfo) {
    setSources((s) => s.map((x) => (x.stem === updated.stem ? updated : x)))
    setEditingSource(null)
  }

  if (networkError) return <p className={styles.networkError}>{networkError}</p>
  if (sources.length === 0) return <p className={styles.empty}>Aucune source importée.</p>

  return (
    <>
      <ul className={styles.list}>
        {sources.map((s) => {
          const displayName = s.pdf_title || s.filename
          const isOpen = openStem === s.stem
          const isConfirming = confirmStem === s.stem
          const isDeleting = deletingStem === s.stem
          const type = resolveType(s)
          const hasViewer = type !== 'url'

          return (
            <li key={s.stem} className={styles.card}>
              <div className={styles.cardHeader}>
                <TypeBadge type={type} />
                <div className={styles.meta}>
                  <span className={styles.title}>{displayName}</span>
                  <div className={styles.details}>
                    {s.author && <span className={styles.detail}>{s.author}</span>}
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
                        onClick={() => handleConfirmDelete(s.stem)}
                        disabled={isDeleting}
                        aria-label="Confirmer la suppression"
                        title="Confirmer"
                      >
                        {isDeleting ? '…' : <Check size={20} />}
                      </button>
                      <button
                        className={styles.iconBtn}
                        onClick={() => setConfirmStem(null)}
                        aria-label="Annuler la suppression"
                        title="Annuler"
                      >
                        <X size={20} />
                      </button>
                    </>
                  ) : (
                    <>
                      {hasViewer && (
                        <button
                          className={styles.iconBtn}
                          onClick={() => setOpenStem(isOpen ? null : s.stem)}
                          aria-label={isOpen ? 'Fermer la prévisualisation' : 'Prévisualiser le fichier'}
                          title={isOpen ? 'Fermer' : 'Prévisualiser'}
                        >
                          {isOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                        </button>
                      )}
                      <button
                        className={styles.iconBtn}
                        onClick={() => setEditingSource(s)}
                        aria-label="Modifier les métadonnées"
                        title="Modifier"
                      >
                        <Pencil size={20} />
                      </button>
                      <button
                        className={`${styles.iconBtn} ${styles.deleteBtn}`}
                        onClick={() => setConfirmStem(s.stem)}
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
        })}
      </ul>

      {editingSource && (
        <MetadataModal
          projectId={projectId}
          source={editingSource}
          onSave={handleSaved}
          onClose={() => setEditingSource(null)}
        />
      )}
    </>
  )
}
