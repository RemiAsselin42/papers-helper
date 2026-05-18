import { useCallback, useEffect, useState } from 'react'
import { HelpCircle, Loader2 } from 'lucide-react'
import { listModels } from '../../api/models'
import {
  GRANULARITY_LABELS,
  getProjectSettings,
  saveGlobalSettings,
  saveProjectSettings,
  type AppSettings,
  type ChunkGranularity,
  type ProjectSettings,
  type ProjectSettingsBundle,
  type ResolvedSettings,
} from '../../api/settings'
import { EmbedModelHelpModal } from '../modals/EmbedModelHelpModal'
import styles from './SettingsView.module.scss'

interface Props {
  projectId: string
  /** Fires after a successful save so the app can refresh derived state
   * (notably the effective auto-enrich flag used by the ingestion pipeline). */
  onSaved?: () => void
  /** Fires when a save changed the embedding model or granularity — the index
   * is then stale and the app runs a full reindex (with the progress toast). */
  onReindex?: () => void
}

const GRANULARITIES: ChunkGranularity[] = ['precis', 'equilibre', 'rapide']

export function SettingsView({ projectId, onSaved, onReindex }: Props) {
  const [bundle, setBundle] = useState<ProjectSettingsBundle | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [globalDraft, setGlobalDraft] = useState<AppSettings | null>(null)
  const [projectDraft, setProjectDraft] = useState<ProjectSettings | null>(null)
  const [savingGlobal, setSavingGlobal] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showModelHelp, setShowModelHelp] = useState(false)

  useEffect(() => {
    setBundle(null)
    setError(null)
    getProjectSettings(projectId)
      .then((b) => {
        setBundle(b)
        setGlobalDraft(b.global_defaults)
        setProjectDraft(b.overrides)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Erreur de chargement'))
    listModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [projectId])

  // A model / granularity change makes the project's index stale → trigger a
  // full reindex. Progress is shown in the app's import toast.
  const maybeReindex = useCallback(
    (prev: ResolvedSettings, next: ResolvedSettings) => {
      if (
        prev.embed_model !== next.embed_model ||
        prev.chunk_granularity !== next.chunk_granularity
      ) {
        onReindex?.()
      }
    },
    [onReindex]
  )

  async function handleSaveGlobal() {
    if (!globalDraft || !bundle) return
    setSavingGlobal(true)
    setError(null)
    try {
      await saveGlobalSettings(globalDraft)
      const next = await getProjectSettings(projectId)
      maybeReindex(bundle.resolved, next.resolved)
      setBundle(next)
      setGlobalDraft(next.global_defaults)
      setProjectDraft(next.overrides)
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur d'enregistrement")
    } finally {
      setSavingGlobal(false)
    }
  }

  async function handleSaveProject() {
    if (!projectDraft || !bundle) return
    setSavingProject(true)
    setError(null)
    try {
      const next = await saveProjectSettings(projectId, projectDraft)
      maybeReindex(bundle.resolved, next.resolved)
      setBundle(next)
      setGlobalDraft(next.global_defaults)
      setProjectDraft(next.overrides)
      onSaved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur d'enregistrement")
    } finally {
      setSavingProject(false)
    }
  }

  if (error && !bundle) return <p className={styles.error}>{error}</p>
  if (!bundle || !globalDraft || !projectDraft) {
    return <p className={styles.muted}>Chargement…</p>
  }

  // <select> options: pulled Ollama models plus the currently-stored values
  // (so a model that isn't pulled anymore still shows as the selection).
  const modelOptions = Array.from(
    new Set([...models, globalDraft.embed_model, bundle.global_defaults.embed_model])
  ).filter(Boolean)

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Paramètres</h1>
      <p className={styles.subtitle}>Les réglages du projet surchargent les défauts globaux.</p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Défauts globaux</h2>

        <div className={styles.field}>
          <div className={styles.labelRow}>
            <span className={styles.label}>Modèle d’embedding</span>
            <button
              type="button"
              className={styles.helpBtn}
              onClick={() => setShowModelHelp((v) => !v)}
              aria-expanded={showModelHelp}
              aria-label="Aide : ajouter un modèle d’embedding"
              title="Comment ajouter un modèle d’embedding"
            >
              <HelpCircle size={15} />
            </button>
          </div>
          <select
            className={styles.select}
            aria-label="Modèle d’embedding"
            value={globalDraft.embed_model}
            onChange={(e) => setGlobalDraft({ ...globalDraft, embed_model: e.target.value })}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Granularité du découpage</span>
          <select
            className={styles.select}
            value={globalDraft.chunk_granularity}
            onChange={(e) =>
              setGlobalDraft({
                ...globalDraft,
                chunk_granularity: e.target.value as ChunkGranularity,
              })
            }
          >
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {GRANULARITY_LABELS[g]}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={globalDraft.auto_enrich}
            onChange={(e) => setGlobalDraft({ ...globalDraft, auto_enrich: e.target.checked })}
          />
          <span className={styles.label}>Enrichissement IA automatique à l’import</span>
        </label>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleSaveGlobal}
            disabled={savingGlobal}
          >
            {savingGlobal && <Loader2 size={16} className={styles.spin} />}
            Enregistrer les défauts
          </button>
        </div>
        <p className={styles.hint}>
          Changer le modèle ou la granularité réindexe automatiquement le projet courant. Un
          changement global oblige aussi de réindexer manuellement les sources des autres projets.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Surcharges du projet courant</h2>

        <label className={styles.field}>
          <span className={styles.label}>Modèle d’embedding</span>
          <select
            className={styles.select}
            value={projectDraft.embed_model ?? ''}
            onChange={(e) =>
              setProjectDraft({ ...projectDraft, embed_model: e.target.value || null })
            }
          >
            <option value="">Par défaut ({bundle.global_defaults.embed_model})</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Granularité du découpage</span>
          <select
            className={styles.select}
            value={projectDraft.chunk_granularity ?? ''}
            onChange={(e) =>
              setProjectDraft({
                ...projectDraft,
                chunk_granularity: (e.target.value || null) as ChunkGranularity | null,
              })
            }
          >
            <option value="">
              Par défaut ({GRANULARITY_LABELS[bundle.global_defaults.chunk_granularity]})
            </option>
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {GRANULARITY_LABELS[g]}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Enrichissement IA automatique à l’import</span>
          <select
            className={styles.select}
            value={projectDraft.auto_enrich === null ? '' : String(projectDraft.auto_enrich)}
            onChange={(e) =>
              setProjectDraft({
                ...projectDraft,
                auto_enrich: e.target.value === '' ? null : e.target.value === 'true',
              })
            }
          >
            <option value="">
              Par défaut ({bundle.global_defaults.auto_enrich ? 'activé' : 'désactivé'})
            </option>
            <option value="true">Activé</option>
            <option value="false">Désactivé</option>
          </select>
        </label>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleSaveProject}
            disabled={savingProject}
          >
            {savingProject && <Loader2 size={16} className={styles.spin} />}
            Enregistrer le projet
          </button>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Valeurs effectives (ce projet)</h2>
        <dl className={styles.effective}>
          <div>
            <dt>Modèle d’embedding</dt>
            <dd>{bundle.resolved.embed_model}</dd>
          </div>
          <div>
            <dt>Granularité</dt>
            <dd>
              {GRANULARITY_LABELS[bundle.resolved.chunk_granularity]} ·{' '}
              {bundle.resolved.max_chunk_chars} caractères / chunk
            </dd>
          </div>
          <div>
            <dt>Enrichissement IA</dt>
            <dd>{bundle.resolved.auto_enrich ? 'Activé' : 'Désactivé'}</dd>
          </div>
        </dl>
      </section>

      {error && <p className={styles.error}>{error}</p>}

      {showModelHelp && <EmbedModelHelpModal onClose={() => setShowModelHelp(false)} />}
    </div>
  )
}
