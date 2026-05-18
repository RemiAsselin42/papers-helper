import { useRef, useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getStoredOllamaModel } from '../../api/llm'
import { consumeGenerateStream, streamGenerate } from '../../api/writing'
import { AutoTextarea } from '../problematique/AutoTextarea'
import { markdownToHtml } from './markdown'
import styles from './GenerationPanel.module.scss'

interface Props {
  projectId: string
  docId: string
  /** Insert the accepted passage (HTML) at the editor's cursor. */
  onInsert: (html: string) => void
  onClose: () => void
}

type Phase = 'idle' | 'streaming' | 'done'

/**
 * Inline panel that streams a RAG-grounded passage from Ollama. The editor
 * stays usable while it is open, so « Insérer » drops the passage at the
 * current cursor position.
 */
export function GenerationPanel({ projectId, docId, onInsert, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [instructions, setInstructions] = useState('')
  const [buffer, setBuffer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const model = getStoredOllamaModel()

  async function runGeneration() {
    if (!model) return
    setError(null)
    setBuffer('')
    setPhase('streaming')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let buf = ''
    try {
      const res = await streamGenerate(projectId, docId, instructions.trim(), model, ctrl.signal)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      await consumeGenerateStream(res.body, (tok) => {
        buf += tok
        setBuffer(buf)
      })
      setPhase('done')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPhase('idle')
      } else {
        setError(err instanceof Error ? err.message : 'Erreur de génération')
        setPhase('idle')
      }
    } finally {
      abortRef.current = null
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>
          <Sparkles size={16} />
          Générer un passage
        </span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Fermer">
          <X size={20} />
        </button>
      </div>

      <AutoTextarea
        className={styles.instructions}
        value={instructions}
        placeholder="Consignes pour la génération (sujet du passage, angle, ton…)"
        onChange={(e) => setInstructions(e.target.value)}
        disabled={phase === 'streaming'}
        aria-label="Consignes de génération"
      />

      {error && <p className={styles.error}>{error}</p>}

      {phase !== 'idle' && (
        <div className={styles.preview}>
          {buffer ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{buffer}</ReactMarkdown>
          ) : (
            <p className={styles.placeholder}>En attente du modèle…</p>
          )}
        </div>
      )}

      <div className={styles.actions}>
        {phase === 'idle' && (
          <button
            type="button"
            className={styles.primary}
            onClick={() => void runGeneration()}
            disabled={!model}
          >
            <Sparkles size={16} />
            Générer
          </button>
        )}
        {phase === 'streaming' && (
          <button type="button" className={styles.ghost} onClick={() => abortRef.current?.abort()}>
            <Loader2 size={16} className={styles.spin} />
            Annuler
          </button>
        )}
        {phase === 'done' && (
          <>
            <button
              type="button"
              className={styles.primary}
              onClick={() => onInsert(markdownToHtml(buffer))}
            >
              Insérer au curseur
            </button>
            <button type="button" className={styles.ghost} onClick={() => setPhase('idle')}>
              Rejeter
            </button>
          </>
        )}
      </div>
    </div>
  )
}
