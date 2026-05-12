import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, CheckCircle2, RefreshCw, WifiOff, X } from 'lucide-react'
import { checkHealth, getStoredOllamaUrl, setStoredOllamaUrl, type HealthData } from '../api/health'
import styles from './OllamaSetupModal.module.scss'

interface OllamaSetupModalProps {
  healthData: HealthData | null
  onConnected: (health: HealthData) => void
  onDismiss: () => void
}

type ModalView = 'main' | 'custom-url'

export function OllamaSetupModal({ healthData, onConnected, onDismiss }: OllamaSetupModalProps) {
  const [view, setView] = useState<ModalView>('main')
  const [urlInput, setUrlInput] = useState(getStoredOllamaUrl() ?? '')
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  async function handleRetry(urlOverride?: string) {
    setRetrying(true)
    setRetryError(null)
    try {
      const health = await checkHealth(urlOverride || undefined)
      if (health.ollama === 'connected') {
        if (urlOverride) setStoredOllamaUrl(urlOverride)
        onConnected(health)
      } else {
        const detail = health.ollama_error ? ` (${health.ollama_error})` : ''
        setRetryError(
          `Ollama ne répond toujours pas à ${health.ollama_url}${detail}. Vérifiez qu'il est démarré.`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setRetryError(`Impossible de joindre le backend Papers Helper (${msg}).`)
    } finally {
      setRetrying(false)
    }
  }

  function handleDismiss() {
    sessionStorage.setItem('ollamaDismissed', '1')
    onDismiss()
  }

  const hasModelIssues =
    healthData?.ollama === 'connected' && healthData.ollama_models.some((m) => !m.available)

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => e.target === e.currentTarget && handleDismiss()}
    >
      <div className={styles.dialog} role="dialog" aria-modal aria-label="Configuration Ollama">
        <div className={styles.header}>
          {view === 'custom-url' ? (
            <button
              className={styles.backBtn}
              onClick={() => {
                setRetryError(null)
                setView('main')
              }}
            >
              <ArrowLeft size={16} />
              Retour
            </button>
          ) : (
            <span className={styles.headerTitle}>
              {hasModelIssues ? 'Modèles Ollama manquants' : 'Ollama n’est pas disponible'}
            </span>
          )}
          <button className={styles.closeBtn} onClick={handleDismiss} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <div className={styles.body}>
          {view === 'main' ? (
            <>
              <div className={styles.statusRow}>
                {hasModelIssues ? (
                  <AlertCircle size={32} className={styles.statusIconWarning} />
                ) : (
                  <WifiOff size={32} className={styles.statusIcon} />
                )}
                <div className={styles.statusContent}>
                  <p className={styles.statusText}>
                    {hasModelIssues
                      ? 'Ollama est démarré mais certains modèles requis ne sont pas installés.'
                      : "Papers Helper nécessite Ollama pour la recherche sémantique et le chat. Ollama s'exécute localement sur votre machine."}
                  </p>
                  {healthData?.ollama_error && (
                    <p className={styles.diagnostic}>
                      <span className={styles.diagnosticError}>{healthData.ollama_error}</span>
                    </p>
                  )}
                </div>
              </div>

              {!hasModelIssues && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Configuration en 3 étapes</h3>
                  <ol className={styles.stepList}>
                    <li className={styles.step}>
                      <span className={styles.stepNum}>1</span>
                      <div className={styles.stepBody}>
                        <p className={styles.stepTitle}>Télécharger Ollama</p>
                        <p className={styles.stepHint}>
                          Depuis{' '}
                          <a
                            href="https://ollama.com/download"
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.link}
                          >
                            ollama.com/download
                          </a>{' '}
                          (macOS, Windows ou Linux).
                        </p>
                      </div>
                    </li>
                    <li className={styles.step}>
                      <span className={styles.stepNum}>2</span>
                      <div className={styles.stepBody}>
                        <p className={styles.stepTitle}>Lancer Ollama</p>
                        <p className={styles.stepHint}>
                          Sur macOS / Windows : ouvrez l&apos;application — elle démarre un serveur
                          local sur <code className={styles.inlineCode}>localhost:11434</code> et
                          reste active en arrière-plan (icône dans la barre des menus / la zone de
                          notification).
                          <br />
                          Sur Linux : exécutez{' '}
                          <code className={styles.inlineCode}>ollama serve</code> dans un terminal.
                        </p>
                      </div>
                    </li>
                    <li className={styles.step}>
                      <span className={styles.stepNum}>3</span>
                      <div className={styles.stepBody}>
                        <p className={styles.stepTitle}>Télécharger les modèles requis</p>
                        <p className={styles.stepHint}>
                          Dans un terminal, exécutez les commandes ci-dessous (~1–5 Go par modèle,
                          téléchargement unique) :
                        </p>
                        <ul className={styles.commandList}>
                          {(healthData?.ollama_models.length
                            ? healthData.ollama_models.map((m) => m.name)
                            : ['nomic-embed-text', 'llama3']
                          ).map((name) => (
                            <li key={name}>
                              <code className={styles.command}>ollama pull {name}</code>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  </ol>
                  <p className={styles.text}>
                    Une fois ces étapes terminées, cliquez sur <strong>Réessayer</strong>{' '}
                    ci-dessous.
                  </p>
                </section>
              )}

              {hasModelIssues && healthData && healthData.ollama_models.length > 0 && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Modèles requis</h3>
                  <ul className={styles.modelList}>
                    {healthData.ollama_models.map((m) => (
                      <li key={m.name} className={styles.modelRow}>
                        {m.available ? (
                          <CheckCircle2 size={14} className={styles.modelOk} />
                        ) : (
                          <AlertCircle size={14} className={styles.modelMiss} />
                        )}
                        <code className={styles.modelName}>{m.name}</code>
                        {!m.available && (
                          <span className={styles.modelHint}>
                            — <code>ollama pull {m.name}</code>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Ollama tourne ailleurs ?</h3>
                <button
                  className={styles.customUrlBtn}
                  onClick={() => {
                    setRetryError(null)
                    setView('custom-url')
                  }}
                >
                  Configurer une URL personnalisée
                </button>
              </section>

              {retryError && <p className={styles.inlineError}>{retryError}</p>}
            </>
          ) : (
            <>
              <div className={styles.urlField}>
                <label className={styles.urlLabel} htmlFor="ollama-url-input">
                  URL Ollama
                </label>
                <input
                  id="ollama-url-input"
                  type="url"
                  className={styles.urlInput}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="http://localhost:11434"
                  onKeyDown={(e) => e.key === 'Enter' && handleRetry(urlInput.trim() || undefined)}
                  autoFocus
                />
                <span className={styles.urlHint}>Défaut : http://localhost:11434</span>
              </div>

              {retryError && <p className={styles.inlineError}>{retryError}</p>}
            </>
          )}
        </div>

        <div className={styles.footer}>
          {view === 'main' ? (
            <>
              <button className={styles.dismissBtn} onClick={handleDismiss}>
                Continuer quand même
              </button>
              <button className={styles.retryBtn} onClick={() => handleRetry()} disabled={retrying}>
                <RefreshCw size={14} className={retrying ? styles.spinning : undefined} />
                {retrying ? 'Vérification…' : 'Réessayer'}
              </button>
            </>
          ) : (
            <>
              <button className={styles.dismissBtn} onClick={handleDismiss}>
                Continuer quand même
              </button>
              <button
                className={styles.retryBtn}
                onClick={() => handleRetry(urlInput.trim() || undefined)}
                disabled={retrying}
              >
                <RefreshCw size={14} className={retrying ? styles.spinning : undefined} />
                {retrying ? 'Test en cours…' : 'Tester la connexion'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
