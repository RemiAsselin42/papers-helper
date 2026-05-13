import { useCallback, useEffect, useState } from 'react'
import {
  getStoredOllamaModel,
  getStoredProvider,
  setStoredOllamaModel,
  setStoredProvider,
  type LLMProvider,
} from '../api/llm'
import { type ProjectInfo } from '../api/projects'
import styles from './AppHeader.module.scss'
import { ModelSelector } from './ModelSelector'

interface AppHeaderProps {
  currentProject: ProjectInfo | null
  onConfigureOllama: () => void
  onRequestApiKey: (provider: Exclude<LLMProvider, 'ollama'>) => void
  onProviderChange?: (provider: LLMProvider) => void
  onOllamaModelChange?: (model: string) => void
}

const DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const TIME_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
})

export function AppHeader({
  currentProject,
  onConfigureOllama,
  onRequestApiKey,
  onProviderChange,
  onOllamaModelChange,
}: AppHeaderProps) {
  const [now, setNow] = useState(() => new Date())

  // Mirrors the globally-stored provider/model. The unified ModelSelector is
  // controlled, so this component owns the state and pushes changes back to
  // localStorage on every onChange.
  const [provider, setProvider] = useState<LLMProvider>(() => getStoredProvider())
  const [ollamaModel, setOllamaModel] = useState<string | null>(() => getStoredOllamaModel())

  useEffect(() => {
    const msToNextMinute = 60_000 - (Date.now() % 60_000)
    let intervalId: number | undefined
    const timeoutId = window.setTimeout(() => {
      setNow(new Date())
      intervalId = window.setInterval(() => setNow(new Date()), 60_000)
    }, msToNextMinute)
    return () => {
      window.clearTimeout(timeoutId)
      if (intervalId !== undefined) window.clearInterval(intervalId)
    }
  }, [])

  const handleChange = useCallback(
    (nextProvider: LLMProvider, nextOllamaModel: string | null) => {
      if (nextProvider !== provider) {
        setStoredProvider(nextProvider)
        setProvider(nextProvider)
        onProviderChange?.(nextProvider)
      }
      if (nextOllamaModel && nextOllamaModel !== ollamaModel) {
        setStoredOllamaModel(nextOllamaModel)
        setOllamaModel(nextOllamaModel)
        onOllamaModelChange?.(nextOllamaModel)
      }
    },
    [provider, ollamaModel, onProviderChange, onOllamaModelChange]
  )

  // Auto-seed the global Ollama model the first time the model list arrives.
  // Without this, the header label is missing the model after a fresh install.
  const handleOllamaModelsLoaded = useCallback(
    (models: string[]) => {
      if (ollamaModel || models.length === 0) return
      const first = models[0]
      setStoredOllamaModel(first)
      setOllamaModel(first)
      onOllamaModelChange?.(first)
    },
    [ollamaModel, onOllamaModelChange]
  )

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <span className={styles.date}>{DATE_FORMAT.format(now)}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span className={styles.time}>{TIME_FORMAT.format(now)}</span>
      </div>

      <div className={styles.center}>
        {currentProject ? (
          <span className={styles.projectName} title={currentProject.name}>
            {currentProject.name}
          </span>
        ) : (
          <span className={styles.noProject}>Aucun projet</span>
        )}
      </div>

      <div className={styles.right}>
        <ModelSelector
          provider={provider}
          ollamaModel={ollamaModel}
          onChange={handleChange}
          onConfigureOllama={onConfigureOllama}
          onRequestApiKey={onRequestApiKey}
          onOllamaModelsLoaded={handleOllamaModelsLoaded}
        />
      </div>
    </header>
  )
}
