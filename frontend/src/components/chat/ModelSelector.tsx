import { Check, ChevronDown, Cpu, KeyRound, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PROVIDER_LABELS, getStoredApiKey, type LLMProvider } from '../../api/llm'
import { listModels } from '../../api/models'
import styles from './ModelSelector.module.scss'

export interface ModelSelectorProps {
  /** Currently selected provider. */
  provider: LLMProvider
  /** Currently selected Ollama model (only meaningful when provider === 'ollama'). */
  ollamaModel: string | null
  /**
   * Called when the user picks a provider or an Ollama model. `ollamaModel` is
   * only set when picking an Ollama model from the flyout, otherwise it is
   * unchanged from the current value.
   */
  onChange: (provider: LLMProvider, ollamaModel: string | null) => void
  /** Called after picking the Ollama provider, to let the host open the setup modal. */
  onConfigureOllama: () => void
  /** Called when the user requests editing/setting an external provider's API key. */
  onRequestApiKey: (provider: Exclude<LLMProvider, 'ollama'>) => void
  /** Called the first time `listModels` returns a non-empty list (to seed defaults). */
  onOllamaModelsLoaded?: (models: string[]) => void
  disabled?: boolean
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
  provider,
  ollamaModel,
  onChange,
  onConfigureOllama,
  onRequestApiKey,
  onOllamaModelsLoaded,
  disabled,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaError, setOllamaError] = useState<string | null>(null)
  const [ollamaHover, setOllamaHover] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const refreshOllamaModels = useCallback(() => {
    listModels()
      .then((list) => {
        setOllamaModels(list)
        setOllamaError(null)
        if (list.length > 0) onOllamaModelsLoaded?.(list)
      })
      .catch(() => {
        setOllamaModels([])
        setOllamaError('Ollama injoignable')
      })
  }, [onOllamaModelsLoaded])

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

  function handleSelect(p: LLMProvider) {
    setOpen(false)
    setOllamaHover(false)
    if (p === 'ollama') {
      onChange('ollama', ollamaModel)
      onConfigureOllama()
    } else {
      onChange(p, null)
      if (!getStoredApiKey(p)) onRequestApiKey(p)
    }
  }

  function handleSelectOllamaModel(model: string) {
    setOpen(false)
    setOllamaHover(false)
    // Picking an Ollama model implicitly switches the provider to 'ollama'.
    onChange('ollama', model)
  }

  const triggerLabel =
    provider === 'ollama' && ollamaModel
      ? `${PROVIDER_LABELS.ollama} · ${ollamaModel}`
      : PROVIDER_LABELS[provider]

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
        disabled={disabled}
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
            const isCurrent = p === provider
            const ready = hasKey(p)
            const isOllama = p === 'ollama'
            return (
              <li
                key={p}
                className={isOllama ? styles.ollamaRow : undefined}
                onMouseEnter={isOllama ? () => setOllamaHover(true) : undefined}
                onMouseLeave={isOllama ? () => setOllamaHover(false) : undefined}
              >
                <div className={styles.itemRow}>
                  <button
                    type="button"
                    className={`${styles.item} ${isCurrent ? styles.itemActive : ''}`}
                    onClick={() => handleSelect(p)}
                    role="option"
                    aria-selected={isCurrent}
                  >
                    <span className={styles.itemMark}>
                      {isCurrent ? <Check size={16} /> : null}
                    </span>
                    <span className={styles.itemLabel}>{PROVIDER_LABELS[p]}</span>
                  </button>
                  {!isOllama &&
                    (ready ? (
                      <button
                        type="button"
                        className={styles.itemAction}
                        onClick={(e) => {
                          e.stopPropagation()
                          setOpen(false)
                          setOllamaHover(false)
                          onRequestApiKey(p)
                        }}
                        title="Modifier la clé API"
                        aria-label={`Modifier la clé API ${PROVIDER_LABELS[p]}`}
                      >
                        <Settings size={16} />
                      </button>
                    ) : (
                      <span className={styles.itemBadge} title="Clé API requise">
                        <KeyRound size={16} />
                      </span>
                    ))}
                </div>

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
                      const isModelActive = provider === 'ollama' && m === ollamaModel
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
                              {isModelActive ? <Check size={16} /> : null}
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
