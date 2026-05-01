import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import styles from './DebugPanel.module.scss'

interface PaperInfo {
  stem: string
  filename: string
  chunk_total: number
}
interface ChunkInfo {
  id: string
  chunk_index: number
  word_count: number
  text: string
}

interface DebugPanelProps {
  refreshKey?: number
}

export function DebugPanel({ refreshKey }: DebugPanelProps) {
  const [papers, setPapers] = useState<PaperInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [selectedStem, setSelectedStem] = useState<string | null>(null)
  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)
  const [chunksError, setChunksError] = useState<string | null>(null)

  async function fetchPapers() {
    setLoading(true)
    setNetworkError(null)
    try {
      const res = await fetch('/api/papers/')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: PaperInfo[] = await res.json()
      setPapers(data)
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'Erreur réseau')
    } finally {
      setLoading(false)
    }
  }

  async function fetchChunks(stem: string) {
    if (selectedStem === stem) {
      setSelectedStem(null)
      setChunks([])
      return
    }
    setSelectedStem(stem)
    setChunksLoading(true)
    setChunksError(null)
    try {
      const res = await fetch(`/api/papers/${encodeURIComponent(stem)}/chunks`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ChunkInfo[] = await res.json()
      setChunks(data)
    } catch (err) {
      setChunksError(err instanceof Error ? err.message : 'Erreur réseau')
    } finally {
      setChunksLoading(false)
    }
  }

  useEffect(() => { fetchPapers() }, [refreshKey])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>ChromaDB debug</span>
        {papers.length > 0 && (
          <span className={styles.count}>{papers.length} paper{papers.length > 1 ? 's' : ''}</span>
        )}
        <button
          className={styles.refreshBtn}
          onClick={fetchPapers}
          disabled={loading}
          aria-label="Rafraîchir"
        >
          <RefreshCw size={14} className={loading ? styles.spinning : undefined} />
        </button>
      </div>

      <div className={styles.body}>
        {papers.length === 0 && !loading && (
          <p className={styles.empty}>Aucun paper indexé.</p>
        )}

        {papers.length > 0 && (
          <div className={styles.paperList}>
            {papers.map(p => (
              <div key={p.stem} className={styles.paperCard}>
                <div
                  className={styles.paperHeader}
                  onClick={() => fetchChunks(p.stem)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && fetchChunks(p.stem)}
                >
                  <span className={styles.paperName}>{p.filename}</span>
                  <span className={styles.paperMeta}>{p.chunk_total} chunks</span>
                </div>

                {selectedStem === p.stem && (
                  <div className={styles.chunkList}>
                    {chunksLoading ? (
                      <p className={styles.chunkLoading}>Chargement…</p>
                    ) : (
                      chunks.map(c => (
                        <details key={c.id} className={styles.chunk}>
                          <summary className={styles.chunkSummary}>
                            chunk {c.chunk_index} — {c.word_count} mots
                          </summary>
                          <pre className={styles.chunkText}>{c.text}</pre>
                        </details>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
