import { ExternalLink, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  API_KEY_LINKS,
  PROVIDER_LABELS,
  getStoredApiKey,
  setStoredApiKey,
  type LLMProvider,
} from '../api/llm'
import styles from './ApiKeyModal.module.scss'

interface Props {
  provider: Exclude<LLMProvider, 'ollama'>
  onSave: () => void
  onClose: () => void
}

export function ApiKeyModal({ provider, onSave, onClose }: Props) {
  const [key, setKey] = useState(getStoredApiKey(provider) ?? '')
  const hasExisting = !!getStoredApiKey(provider)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function handleSave() {
    setStoredApiKey(provider, key.trim() || null)
    onSave()
  }

  function handleRemove() {
    setStoredApiKey(provider, null)
    onSave()
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.dialog} role="dialog" aria-modal aria-label={`Clé API ${PROVIDER_LABELS[provider]}`}>
        <div className={styles.header}>
          <span className={styles.title}>Clé API — {PROVIDER_LABELS[provider]}</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.hint}>
            La clé est stockée localement dans votre navigateur et transmise uniquement à l'API{' '}
            {PROVIDER_LABELS[provider]}.{' '}
            <a
              href={API_KEY_LINKS[provider]}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              Obtenir une clé <ExternalLink size={11} />
            </a>
          </p>
          <label className={styles.label} htmlFor="api-key-input">
            Clé API
          </label>
          <input
            id="api-key-input"
            type="password"
            className={styles.input}
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="sk-…"
            onKeyDown={e => e.key === 'Enter' && key.trim() && handleSave()}
            autoFocus
          />
        </div>

        <div className={styles.footer}>
          {hasExisting && (
            <button className={styles.removeBtn} onClick={handleRemove}>
              Supprimer
            </button>
          )}
          <button className={styles.cancelBtn} onClick={onClose}>
            Annuler
          </button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={!key.trim()}>
            Enregistrer
          </button>
        </div>
      </div>
    </div>
  )
}
