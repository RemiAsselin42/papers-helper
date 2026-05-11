import { useEffect, useState } from 'react'
import { type ProjectInfo } from '../api/projects'
import { type LLMProvider } from '../api/llm'
import { ModelSelector } from './ModelSelector'
import styles from './AppHeader.module.scss'

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
          onConfigureOllama={onConfigureOllama}
          onRequestApiKey={onRequestApiKey}
          onProviderChange={onProviderChange}
          onOllamaModelChange={onOllamaModelChange}
        />
      </div>
    </header>
  )
}
