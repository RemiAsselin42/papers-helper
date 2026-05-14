import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import {
  consumeCondenseStream,
  streamCondense,
  type CondenseProgress,
} from '../../api/condense'
import {
  getStoredApiKey,
  getStoredExternalModel,
  getStoredOllamaModel,
  getStoredProvider,
  PROVIDER_LABELS,
  type LLMProvider,
} from '../../api/llm'
import { OLLAMA_FALLBACK_MODEL } from '../../hooks/usePerChatModel'
import { updateSourceMetadata, type SourceInfo, type UpdateMetadataPayload } from '../../api/papers'
import { extractBibtexCategories } from '../../utils/bibtex'
import { ABSTRACT_PROMPT } from '../../prompts/abstract'
import styles from './MetadataModal.module.scss'

interface AuthorEntry {
  first_name: string
  last_name: string
}

interface MetadataDraft {
  pdf_title: string
  authors: AuthorEntry[]
  year: string
  publication: string
  doi: string
  abstract: string
  notes: string
}

interface MetadataModalProps {
  projectId: string
  source: SourceInfo
  onSave: (updated: SourceInfo) => void
  onClose: () => void
  /**
   * Hard-gate: when false, the IA button is not rendered. /condense's map step
   * always runs on Ollama, so without it the abstract generation is broken
   * for any non-trivially short doc — better to hide the affordance entirely
   * than to surface runtime errors.
   */
  ollamaAvailable: boolean
}

function parseAuthors(source: SourceInfo): AuthorEntry[] {
  if (source.authors_json) {
    try {
      const parsed = JSON.parse(source.authors_json)
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Handle both CSL format {family, given} and internal {last_name, first_name}
        return (parsed as Record<string, string>[]).map((a) => ({
          first_name: a.first_name ?? a.given ?? '',
          last_name: a.last_name ?? a.family ?? '',
        }))
      }
    } catch {
      // fall through
    }
  }
  if (source.author) {
    return source.author.split(/\s*;\s*/).map((part) => {
      const [last = '', first = ''] = part.split(/\s*,\s*/)
      return { last_name: last.trim(), first_name: first.trim() }
    })
  }
  return [{ first_name: '', last_name: '' }]
}

/**
 * Build the human-readable lines shown in the IA progress hover panel. Returns
 * 1–3 strings: a top-line phase label, an optional doc-counter, and an
 * optional chunk-counter. The provider name is interpolated in the reduce
 * label so the user sees which model is running each step.
 */
function progressLines(p: CondenseProgress, provider: LLMProvider | null): string[] {
  const lines: string[] = []
  const providerLabel = provider ? PROVIDER_LABELS[provider] : null

  if (p.stem_index !== undefined && p.stems_total !== undefined) {
    const stemLabel = p.stem ? ` · ${p.stem}` : ''
    lines.push(`Document ${p.stem_index} / ${p.stems_total}${stemLabel}`)
  }

  switch (p.phase) {
    case 'start': {
      const strategyLabel =
        p.strategy === 'full'
          ? 'Synthèse en un appel'
          : p.strategy === 'map_reduce_single'
            ? 'Pré-réduction par chunk'
            : 'Pré-réduction multi-documents'
      lines.push(`Démarrage · ${strategyLabel}`)
      break
    }
    case 'generating':
      lines.push(providerLabel ? `Synthèse via ${providerLabel}…` : 'Synthèse en cours…')
      break
    case 'map':
      if (p.done !== undefined && p.total !== undefined) {
        lines.push(`Pré-réduction · chunk ${p.done} / ${p.total}`)
      } else {
        lines.push('Pré-réduction…')
      }
      break
    case 'reduce':
      lines.push(providerLabel ? `Synthèse via ${providerLabel}…` : 'Synthèse…')
      break
    case 'global_reduce':
      lines.push(providerLabel ? `Synthèse finale via ${providerLabel}…` : 'Synthèse finale…')
      break
  }
  return lines
}

function authorsToFlat(authors: AuthorEntry[]): string {
  return authors
    .filter((a) => a.first_name || a.last_name)
    .map((a) =>
      a.last_name && a.first_name ? `${a.last_name}, ${a.first_name}` : a.last_name || a.first_name
    )
    .join(' ; ')
}

export function MetadataModal({
  projectId,
  source,
  onSave,
  onClose,
  ollamaAvailable,
}: MetadataModalProps) {
  const [draft, setDraft] = useState<MetadataDraft>(() => ({
    pdf_title: source.pdf_title,
    authors: parseAuthors(source),
    year: source.year,
    publication: source.publication,
    doi: source.doi,
    abstract: source.abstract,
    notes: source.notes,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generatingAbstract, setGeneratingAbstract] = useState(false)
  const [abstractError, setAbstractError] = useState<string | null>(null)
  const [progress, setProgress] = useState<CondenseProgress | null>(null)
  const [progressProvider, setProgressProvider] = useState<LLMProvider | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const generateAbortRef = useRef<AbortController | null>(null)

  const requestClose = useCallback(() => {
    generateAbortRef.current?.abort()
    onClose()
  }, [onClose])

  useEffect(() => {
    firstInputRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

  useEffect(() => () => generateAbortRef.current?.abort(), [])

  function setField<K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function setAuthor(index: number, field: keyof AuthorEntry, value: string) {
    setDraft((d) => {
      const authors = d.authors.map((a, i) => (i === index ? { ...a, [field]: value } : a))
      return { ...d, authors }
    })
  }

  function addAuthor() {
    setDraft((d) => ({ ...d, authors: [...d.authors, { first_name: '', last_name: '' }] }))
  }

  function removeAuthor(index: number) {
    setDraft((d) => {
      const authors = d.authors.filter((_, i) => i !== index)
      return { ...d, authors: authors.length > 0 ? authors : [{ first_name: '', last_name: '' }] }
    })
  }

  async function handleGenerateAbstract() {
    if (generatingAbstract) {
      generateAbortRef.current?.abort()
      return
    }
    if (!source.indexed) {
      setAbstractError(
        "La source n'est pas indexée — le contenu n'est pas disponible pour l'IA."
      )
      return
    }
    const provider = getStoredProvider()
    const model =
      provider === 'ollama'
        ? (getStoredOllamaModel() ?? OLLAMA_FALLBACK_MODEL)
        : getStoredExternalModel(provider)
    if (provider !== 'ollama' && !getStoredApiKey(provider)) {
      setAbstractError(`Clé API manquante pour ${PROVIDER_LABELS[provider]}.`)
      return
    }
    if (provider === 'ollama' && !getStoredOllamaModel()) {
      setAbstractError('Aucun modèle Ollama sélectionné.')
      return
    }
    if (provider !== 'ollama' && !model) {
      setAbstractError(`Aucun modèle sélectionné pour ${PROVIDER_LABELS[provider]}.`)
      return
    }

    setAbstractError(null)
    setGeneratingAbstract(true)
    setProgress(null)
    setProgressProvider(provider)
    setField('abstract', '')

    const controller = new AbortController()
    generateAbortRef.current = controller
    let acc = ''
    try {
      const res = await streamCondense(
        projectId,
        ABSTRACT_PROMPT,
        [source.stem],
        model,
        controller.signal,
        provider
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('Pas de corps de réponse')
      await consumeCondenseStream(
        res.body,
        (token) => {
          acc += token
          setField('abstract', acc)
        },
        setProgress
      )
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = (err as Error).message?.trim()
        setAbstractError(msg ? `Erreur de génération : ${msg}` : 'Erreur de génération.')
      }
    } finally {
      setGeneratingAbstract(false)
      setProgress(null)
      setProgressProvider(null)
      generateAbortRef.current = null
    }
  }

  async function handleSave() {
    if (generatingAbstract) generateAbortRef.current?.abort()
    setSaving(true)
    setError(null)
    const authors = draft.authors.filter((a) => a.first_name || a.last_name)
    const payload: UpdateMetadataPayload = {
      pdf_title: draft.pdf_title,
      author: authorsToFlat(authors),
      authors_json: JSON.stringify(authors),
      year: draft.year,
      publication: draft.publication,
      doi: draft.doi,
      abstract: draft.abstract,
      notes: draft.notes,
    }
    try {
      const updated = await updateSourceMetadata(projectId, source.stem, payload)
      onSave(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      setSaving(false)
    }
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <div className={styles.dialog} role="dialog" aria-modal aria-label="Modifier les métadonnées">
        <div className={styles.header}>
          <span className={styles.headerTitle}>Modifier les métadonnées</span>
          <button className={styles.closeBtn} onClick={requestClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>Titre</label>
            <input
              ref={firstInputRef}
              className={styles.input}
              value={draft.pdf_title}
              onChange={(e) => setField('pdf_title', e.target.value)}
              placeholder="Titre de la source"
              disabled={saving}
            />
          </div>

          {extractBibtexCategories(source.pdf_title).length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Catégories</label>
              <div className={styles.categories}>
                {extractBibtexCategories(source.pdf_title).map((cat) => (
                  <span key={cat} className={styles.categoryTag}>
                    {cat}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Auteurs</label>
            <div className={styles.authorsList}>
              {draft.authors.map((author, i) => (
                <div key={i} className={styles.authorRow}>
                  <input
                    className={styles.input}
                    value={author.last_name}
                    onChange={(e) => setAuthor(i, 'last_name', e.target.value)}
                    placeholder="Nom"
                    disabled={saving}
                  />
                  <input
                    className={styles.input}
                    value={author.first_name}
                    onChange={(e) => setAuthor(i, 'first_name', e.target.value)}
                    placeholder="Prénom"
                    disabled={saving}
                  />
                  <button
                    className={styles.removeAuthorBtn}
                    onClick={() => removeAuthor(i)}
                    disabled={saving}
                    aria-label="Supprimer cet auteur"
                    title="Supprimer"
                    tabIndex={-1}
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              ))}
              <button className={styles.addAuthorBtn} onClick={addAuthor} disabled={saving}>
                <Plus size={16} /> Ajouter un auteur
              </button>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label}>Année</label>
              <input
                className={styles.input}
                value={draft.year}
                onChange={(e) => setField('year', e.target.value)}
                placeholder="2024"
                disabled={saving}
              />
            </div>
            <div className={`${styles.field} ${styles.fieldGrow}`}>
              <label className={styles.label}>Publication / Éditeur</label>
              <input
                className={styles.input}
                value={draft.publication}
                onChange={(e) => setField('publication', e.target.value)}
                placeholder="Revue, éditeur ou site"
                disabled={saving}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>DOI</label>
            <input
              className={styles.input}
              value={draft.doi}
              onChange={(e) => setField('doi', e.target.value)}
              placeholder="10.xxxx/xxxxx"
              disabled={saving}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Résumé</label>
            <div className={styles.textareaWrap}>
              <textarea
                className={
                  ollamaAvailable
                    ? `${styles.textarea} ${styles.textareaWithIa}`
                    : styles.textarea
                }
                value={draft.abstract}
                onChange={(e) => setField('abstract', e.target.value)}
                placeholder="Résumé ou description de la source"
                disabled={saving || generatingAbstract}
                rows={4}
              />
              {ollamaAvailable && (
                <div className={styles.iaBtnWrap}>
                  <button
                    type="button"
                    className={styles.iaBtn}
                    onClick={handleGenerateAbstract}
                    disabled={saving}
                    title={
                      generatingAbstract ? 'Annuler la génération' : 'Générer un résumé avec l’IA'
                    }
                    aria-label={
                      generatingAbstract
                        ? 'Annuler la génération du résumé'
                        : 'Générer un résumé avec l’IA'
                    }
                  >
                    {generatingAbstract ? (
                      <Loader2 size={14} className={styles.iaSpin} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    <span>IA</span>
                  </button>
                  {generatingAbstract && progress && (
                    <div
                      className={styles.iaProgressPanel}
                      role="status"
                      aria-live="polite"
                      aria-label="Avancement de la génération"
                    >
                      <div className={styles.iaProgressTitle}>Génération en cours</div>
                      {progressLines(progress, progressProvider).map((line) => (
                        <div key={line} className={styles.iaProgressLine}>
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {abstractError && <p className={styles.error}>{abstractError}</p>}
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Notes</label>
            <textarea
              className={styles.textarea}
              value={draft.notes}
              onChange={(e) => setField('notes', e.target.value)}
              placeholder="Notes personnelles"
              disabled={saving}
              rows={3}
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={requestClose} disabled={saving}>
            Annuler
          </button>
          <button
            className={styles.saveBtn}
            onClick={handleSave}
            disabled={saving || generatingAbstract}
          >
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}
