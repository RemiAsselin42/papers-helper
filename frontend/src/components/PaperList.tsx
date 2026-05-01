import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, FileText, Trash2 } from 'lucide-react'
import styles from './PaperList.module.scss'

interface PaperInfo {
  stem: string
  filename: string
  chunk_total: number
  pdf_title: string
  author: string
  year: string
}

interface PaperListProps {
  refreshKey?: number
  onDelete?: () => void
}

export function PaperList({ refreshKey, onDelete }: PaperListProps) {
  const [papers, setPapers] = useState<PaperInfo[]>([])
  const [deleting, setDeleting] = useState<string | null>(null)
  const [openStem, setOpenStem] = useState<string | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)

  async function fetchPapers() {
    try {
      const res = await fetch('/api/papers/')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: PaperInfo[] = await res.json()
      setPapers(data)
      setNetworkError(null)
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'Erreur réseau')
    }
  }

  async function handleDelete(stem: string) {
    setDeleting(stem)
    try {
      await fetch(`/api/papers/${encodeURIComponent(stem)}`, { method: 'DELETE' })
      setPapers(p => p.filter(x => x.stem !== stem))
      if (openStem === stem) setOpenStem(null)
      onDelete?.()
    } finally {
      setDeleting(null)
    }
  }

  useEffect(() => { fetchPapers() }, [refreshKey])

  if (networkError) return (
    <p className={styles.networkError}>{networkError}</p>
  )

  if (papers.length === 0) return (
    <p className={styles.empty}>Aucun paper importé.</p>
  )

  return (
    <ul className={styles.list}>
      {papers.map(p => {
        const displayName = p.pdf_title || p.filename
        const isOpen = openStem === p.stem

        return (
          <li key={p.stem} className={styles.card}>
            <div className={styles.cardHeader}>
              <FileText size={16} className={styles.fileIcon} />
              <div className={styles.meta}>
                <span className={styles.title}>{displayName}</span>
                <div className={styles.details}>
                  {p.author && <span className={styles.detail}>{p.author}</span>}
                  {p.author && p.year && <span className={styles.sep}>·</span>}
                  {p.year && <span className={styles.detail}>{p.year}</span>}
                  <span className={styles.sep}>·</span>
                  <span className={styles.detail}>{p.chunk_total} chunks</span>
                </div>
              </div>
              <div className={styles.actions}>
                <button
                  className={styles.iconBtn}
                  onClick={() => setOpenStem(isOpen ? null : p.stem)}
                  aria-label={isOpen ? 'Fermer le lecteur' : 'Ouvrir le lecteur PDF'}
                  title={isOpen ? 'Fermer' : 'Lire le PDF'}
                >
                  {isOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
                <button
                  className={`${styles.iconBtn} ${styles.deleteBtn}`}
                  onClick={() => handleDelete(p.stem)}
                  disabled={deleting === p.stem}
                  aria-label={`Supprimer ${p.filename}`}
                  title="Supprimer"
                >
                  {deleting === p.stem ? '…' : <Trash2 size={14} />}
                </button>
              </div>
            </div>

            {isOpen && (
              <div className={styles.viewer}>
                <iframe
                  src={`/api/papers/${encodeURIComponent(p.stem)}/file`}
                  className={styles.iframe}
                  title={displayName}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
