import { Check, ChevronDown, Cpu, KeyRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PROVIDER_LABELS,
  getStoredApiKey,
  getStoredOllamaModel,
  getStoredProvider,
  setStoredOllamaModel,
  setStoredProvider,
  type LLMProvider,
} from '../api/llm'
import { listModels } from '../api/projects'
import styles from './ModelSelector.module.scss'

interface ModelSelectorProps {
  onConfigureOllama: () => void
  onRequestApiKey: (provider: Exclude<LLMProvider, 'ollama'>) => void
  onProviderChange?: (provider: LLMProvider) => void
  onOllamaModelChange?: (model: string) => void
}

const PROVIDER_ORDER: LLMProvider[] = [
  'ollama',
  'anthropic',
  'openai',
  'gemini',
  'perplexity',
  'deepseek',
]

function hasKey(provider: LLMProvider): boolean {
  if (provider === 'ollama') return true
  return !!getStoredApiKey(provider)
}

export function ModelSelector({
  onConfigureOllama,
  onRequestApiKey,
  onProviderChange,
  onOllamaModelChange,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<LLMProvider>(() => getStoredProvider())
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [currentOllamaModel, setCurrentOllamaModel] = useState<string | null>(() =>
    getStoredOllamaModel()
  )
  const [ollamaHover, setOllamaHover] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const refreshOllamaModels = useCallback(() => {
    listModels()
      .then((list) => {
        setOllamaModels(list)
        setOllamaError(null)
        if (list.length > 0 && !getStoredOllamaModel()) {
          setStoredOllamaModel(list[0])
          setCurrentOllamaModel(list[0])
          onOllamaModelChange?.(list[0])
        }
      })
      .catch(() => {
        setOllamaModels([])
        setOllamaError('Ollama injoignable')
      })
  }, [onOllamaModelChange])

  useEffect(() => {
    refreshOllamaModels()
  }, [refreshOllamaModels])

  useEffect(() => {
    if (open) refreshOllamaModels()
  }, [open, refreshOllamaModels])

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setOllamaHover(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setOllamaHover(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function handleSelect(provider: LLMProvider) {
    setStoredProvider(provider)
    setCurrent(provider)
    setOpen(false)
    setOllamaHover(false)
    onProviderChange?.(provider)
    if (provider === 'ollama') {
      onConfigureOllama()
    } else if (!getStoredApiKey(provider)) {
      onRequestApiKey(provider)
    }
  }

  function handleSelectOllamaModel(model: string) {
    setStoredOllamaModel(model)
    setCurrentOllamaModel(model)
    setOpen(false)
    setOllamaHover(false)
    if (current !== 'ollama') {
      setStoredProvider('ollama')
      setCurrent('ollama')
      onProviderChange?.('ollama')
    }
    onOllamaModelChange?.(model)
  }

  const triggerLabel =
    current === 'ollama' && currentOllamaModel
      ? `${PROVIDER_LABELS.ollama} · ${currentOllamaModel}`
      : PROVIDER_LABELS[current]

  return (
    <div ref={rootRef} className={styles.selector}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Sélectionner le modèle d'IA"
        title="Modèle d'IA"
      >
        <span className={styles.icon}>
          <Cpu size={20} />
        </span>
        <span className={styles.label}>{triggerLabel}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>
          <ChevronDown size={20} />
        </span>
      </button>

      {open && (
        <ul className={styles.list} role="listbox" aria-label="Modèles d'IA disponibles">
          {PROVIDER_ORDER.map((p) => {
            const isCurrent = p === current
            const ready = hasKey(p)
            const isOllama = p === 'ollama'
            return (
              <li
                key={p}
                className={isOllama ? styles.ollamaRow : undefined}
                onMouseEnter={isOllama ? () => setOllamaHover(true) : undefined}
                onMouseLeave={isOllama ? () => setOllamaHover(false) : undefined}
              >
                <button
                  type="button"
                  className={`${styles.item} ${isCurrent ? styles.itemActive : ''}`}
                  onClick={() => handleSelect(p)}
                  role="option"
                  aria-selected={isCurrent}
                >
                  <span className={styles.itemMark}>{isCurrent ? <Check size={14} /> : null}</span>
                  <span className={styles.itemLabel}>{PROVIDER_LABELS[p]}</span>
                  {!ready && (
                    <span className={styles.itemBadge} title="Clé API requise">
                      <KeyRound size={12} />
                    </span>
                  )}
                </button>

                {isOllama && ollamaHover && (
                  <ul
                    className={styles.flyout}
                    role="listbox"
                    aria-label="Modèles Ollama installés"
                  >
                    {ollamaError && <li className={styles.flyoutError}>{ollamaError}</li>}
                    {!ollamaError && ollamaModels.length === 0 && (
                      <li className={styles.flyoutInfo}>Aucun modèle installé.</li>
                    )}
                    {ollamaModels.map((m) => {
                      const isModelActive = m === currentOllamaModel
                      return (
                        <li key={m}>
                          <button
                            type="button"
                            className={`${styles.item} ${isModelActive ? styles.itemActive : ''}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSelectOllamaModel(m)
                            }}
                            role="option"
                            aria-selected={isModelActive}
                          >
                            <span className={styles.itemMark}>
                              {isModelActive ? <Check size={14} /> : null}
                            </span>
                            <span className={styles.itemLabel}>{m}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
