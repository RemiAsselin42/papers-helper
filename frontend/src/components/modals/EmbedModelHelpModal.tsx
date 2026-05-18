import { useEffect } from 'react'
import { X } from 'lucide-react'
import styles from './EmbedModelHelpModal.module.scss'

interface EmbedModelInfo {
  name: string
  ctx: string
  dim: number
  size: string
  lang: string
  note?: string
}

// `ollama pull` command + headline characteristics for a few embedding models.
const EMBED_MODEL_GUIDE: EmbedModelInfo[] = [
  {
    name: 'nomic-embed-text',
    ctx: '2048',
    dim: 768,
    size: '~280 Mo',
    lang: 'EN',
    note: 'défaut, léger',
  },
  {
    name: 'bge-m3',
    ctx: '8192',
    dim: 1024,
    size: '~1,2 Go',
    lang: 'multilingue',
    note: 'recommandé FR/EN',
  },
  { name: 'snowflake-arctic-embed2', ctx: '8192', dim: 1024, size: '~1,2 Go', lang: 'multilingue' },
  {
    name: 'mxbai-embed-large',
    ctx: '512',
    dim: 1024,
    size: '~670 Mo',
    lang: 'EN',
    note: 'contexte court',
  },
]

interface Props {
  onClose: () => void
}

export function EmbedModelHelpModal({ onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.dialog} role="dialog" aria-modal aria-label="Modèles d’embedding">
        <div className={styles.header}>
          <span className={styles.headerTitle}>Modèles d’embedding</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.text}>
            Pour ajouter un modèle, lancez la commande dans un terminal puis rafraîchissez la page —
            le modèle apparaîtra dans la liste.
          </p>
          <ul className={styles.list}>
            {EMBED_MODEL_GUIDE.map((m) => (
              <li key={m.name} className={styles.item}>
                <code className={styles.cmd}>ollama pull {m.name}</code>
                <span className={styles.meta}>
                  {m.ctx} tokens de contexte · {m.dim}d · {m.size} · {m.lang}
                  {m.note ? ` · ${m.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.text}>
            Un contexte plus grand autorise une granularité plus grossière (chunks plus gros). Un
            modèle multilingue est conseillé pour un corpus en français.
          </p>
        </div>
      </div>
    </div>
  )
}
