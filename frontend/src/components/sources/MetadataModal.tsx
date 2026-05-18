import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { type CondenseProgress } from '../../api/condense'
import { PROVIDER_LABELS, type LLMProvider } from '../../api/llm'
import { updateSourceMetadata, type SourceInfo, type UpdateMetadataPayload } from '../../api/papers'
import { mergeCategories, splitCategoriesCsv } from '../../utils/categories'
import { categoryColor } from '../../utils/categoryColor'
import { generateAbstractForStem, generateCategoriesFromAbstract } from '../../utils/enrich'
import { canRunIA } from '../../utils/providerConfig'
import { stripBibtexBraces } from '../../utils/bibtex'
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
  categories: string[]
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

function initialCategories(source: SourceInfo): string[] {
  return splitCategoriesCsv(source.categories)
}

export function MetadataModal({
  projectId,
  source,
  onSave,
  onClose,
  ollamaAvailable,
}: MetadataModalProps) {
  const [draft, setDraft] = useState<MetadataDraft>(() => ({
    // No title in metadata → fall back to the filename, matching SourceCard.
    pdf_title: stripBibtexBraces(source.pdf_title || source.filename),
    authors: parseAuthors(source),
    year: source.year,
    publication: source.publication,
    doi: source.doi,
    abstract: source.abstract,
    notes: source.notes,
    categories: initialCategories(source),
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generatingAbstract, setGeneratingAbstract] = useState(false)
  const [abstractError, setAbstractError] = useState<string | null>(null)
  const [progress, setProgress] = useState<CondenseProgress | null>(null)
  const [progressProvider, setProgressProvider] = useState<LLMProvider | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryDraft, setNewCategoryDraft] = useState('')
  const [generatingCategories, setGeneratingCategories] = useState(false)
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const generateAbortRef = useRef<AbortController | null>(null)
  const generateCategoriesAbortRef = useRef<AbortController | null>(null)
  const newCategoryInputRef = useRef<HTMLInputElement>(null)
  const addCategoryBtnRef = useRef<HTMLButtonElement>(null)
  const categoryPopoverRef = useRef<HTMLDivElement>(null)
  // Fixed-viewport coords for the "new category" popover. It is portaled to
  // document.body so the modal's `overflow` containers can't crop it.
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number } | null>(null)
  // Fields the user has edited in this modal session. Background enrichment
  // refreshes the `source` prop; the sync effect below pulls abstract /
  // categories updates into the draft but never clobbers a touched field.
  const touchedRef = useRef<Set<keyof MetadataDraft>>(new Set())

  const requestClose = useCallback(() => {
    generateAbortRef.current?.abort()
    generateCategoriesAbortRef.current?.abort()
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

  useEffect(() => {
    if (addingCategory) {
      newCategoryInputRef.current?.focus()
    }
  }, [addingCategory])

  // Close the (portaled) "new category" popover on any click outside it. The
  // toggle button is excluded so its own onClick keeps handling open/close.
  useEffect(() => {
    if (!addingCategory) return
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node
      if (
        categoryPopoverRef.current?.contains(target) ||
        addCategoryBtnRef.current?.contains(target)
      ) {
        return
      }
      setNewCategoryDraft('')
      setAddingCategory(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [addingCategory])

  // Anchor the portaled popover above the "Ajouter" button, flipping below
  // when there isn't enough room, and clamp it inside the viewport so it can
  // never be clipped or pushed off-screen.
  useLayoutEffect(() => {
    if (!addingCategory) {
      setPopoverPos(null)
      return
    }
    const POPOVER_W = 265
    const POPOVER_H = 56
    const GAP = 8
    function place() {
      const rect = addCategoryBtnRef.current?.getBoundingClientRect()
      if (!rect) return
      const left = Math.max(
        GAP,
        Math.min(rect.left, window.innerWidth - POPOVER_W - GAP)
      )
      const above = rect.top - GAP - POPOVER_H
      const top = above >= GAP ? above : rect.bottom + GAP
      setPopoverPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [addingCategory])

  useEffect(
    () => () => {
      generateAbortRef.current?.abort()
      generateCategoriesAbortRef.current?.abort()
    },
    []
  )

  // Pull background-enrichment updates (auto-generated abstract / categories)
  // into the draft when the parent refreshes the `source` prop — leaving any
  // field the user has already edited in this session untouched.
  useEffect(() => {
    setDraft((d) => {
      const next = { ...d }
      let changed = false
      if (!touchedRef.current.has('abstract') && source.abstract !== d.abstract) {
        next.abstract = source.abstract
        changed = true
      }
      if (!touchedRef.current.has('categories')) {
        const fresh = initialCategories(source)
        if (fresh.join(' ') !== d.categories.join(' ')) {
          next.categories = fresh
          changed = true
        }
      }
      return changed ? next : d
    })
  }, [source])

  function setField<K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) {
    touchedRef.current.add(key)
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

  function commitNewCategory() {
    const trimmed = newCategoryDraft.trim()
    if (!trimmed) {
      setAddingCategory(false)
      return
    }
    touchedRef.current.add('categories')
    setDraft((d) => ({
      ...d,
      categories: mergeCategories(d.categories, [trimmed]),
    }))
    setNewCategoryDraft('')
    setAddingCategory(false)
  }

  function removeCategory(cat: string) {
    touchedRef.current.add('categories')
    setDraft((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.toLowerCase() !== cat.toLowerCase()),
    }))
  }

  async function handleGenerateAbstract() {
    if (generatingAbstract) {
      generateAbortRef.current?.abort()
      return
    }
    if (!source.indexed) {
      setAbstractError("La source n'est pas indexée — le contenu n'est pas disponible pour l'IA.")
      return
    }
    const readiness = canRunIA(ollamaAvailable)
    if (!readiness.ok) {
      setAbstractError(readiness.reason ?? 'Provider IA non configuré.')
      return
    }

    setAbstractError(null)
    setGeneratingAbstract(true)
    setProgress(null)
    setProgressProvider(readiness.provider)
    setField('abstract', '')

    const controller = new AbortController()
    generateAbortRef.current = controller
    let acc = ''
    try {
      // Tokens stream in raw for a live preview; the resolved value is the
      // cleaned abstract (preamble + Markdown stripped) — adopt it as final.
      const finalAbstract = await generateAbstractForStem({
        projectId,
        stem: source.stem,
        model: readiness.model,
        provider: readiness.provider,
        signal: controller.signal,
        onToken: (token) => {
          acc += token
          setField('abstract', acc)
        },
        onProgress: setProgress,
      })
      setField('abstract', finalAbstract)
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

  async function handleGenerateCategories() {
    if (generatingCategories) {
      generateCategoriesAbortRef.current?.abort()
      return
    }
    // Categories are derived from the abstract — no Chroma index needed, but
    // an abstract must exist (generated or hand-written).
    if (!draft.abstract.trim()) {
      setCategoriesError("Génère ou saisis d'abord un résumé — les catégories en sont dérivées.")
      return
    }
    const readiness = canRunIA(ollamaAvailable)
    if (!readiness.ok) {
      setCategoriesError(readiness.reason ?? 'Provider IA non configuré.')
      return
    }

    setCategoriesError(null)
    setGeneratingCategories(true)

    const controller = new AbortController()
    generateCategoriesAbortRef.current = controller
    try {
      const parsed = await generateCategoriesFromAbstract({
        projectId,
        abstract: draft.abstract,
        model: readiness.model,
        provider: readiness.provider,
        signal: controller.signal,
      })
      touchedRef.current.add('categories')
      setDraft((d) => ({
        ...d,
        categories: mergeCategories(d.categories, parsed),
      }))
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const msg = (err as Error).message?.trim()
        setCategoriesError(msg ? `Erreur de génération : ${msg}` : 'Erreur de génération.')
      }
    } finally {
      setGeneratingCategories(false)
      generateCategoriesAbortRef.current = null
    }
  }

  async function handleSave() {
    if (generatingAbstract) generateAbortRef.current?.abort()
    if (generatingCategories) generateCategoriesAbortRef.current?.abort()
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
      categories: draft.categories.join(', '),
    }
    try {
      const updated = await updateSourceMetadata(projectId, source.stem, payload)
      onSave(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      setSaving(false)
    }
  }

  const iaCategoriesActive = ollamaAvailable

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

          <div className={styles.field}>
            <label className={styles.label}>Catégories</label>
            <div className={styles.categoriesRow}>
              {draft.categories.map((cat) => {
                const c = categoryColor(cat)
                return (
                  <span
                    key={cat}
                    className={styles.categoryTag}
                    style={{ background: c.bg, color: c.fg, borderColor: c.border }}
                  >
                    {cat}
                    <button
                      type="button"
                      className={styles.categoryRemoveBtn}
                      onClick={() => removeCategory(cat)}
                      aria-label={`Supprimer la catégorie ${cat}`}
                      title="Supprimer"
                      disabled={saving}
                      style={{ color: c.fg }}
                    >
                      <X size={16} />
                    </button>
                  </span>
                )
              })}
              <div className={styles.addCategoryWrap}>
                <button
                  ref={addCategoryBtnRef}
                  type="button"
                  className={styles.addCategoryBtn}
                  onClick={() => setAddingCategory((v) => !v)}
                  disabled={saving}
                  aria-expanded={addingCategory}
                  aria-label="Ajouter une catégorie"
                >
                  <Plus size={16} /> Ajouter
                </button>
                {addingCategory &&
                  popoverPos &&
                  createPortal(
                    <div
                      ref={categoryPopoverRef}
                      className={styles.categoryPopover}
                      role="dialog"
                      aria-label="Nouvelle catégorie"
                      style={{ left: popoverPos.left, top: popoverPos.top }}
                    >
                      <input
                        ref={newCategoryInputRef}
                        className={styles.input}
                        value={newCategoryDraft}
                        onChange={(e) => setNewCategoryDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitNewCategory()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setNewCategoryDraft('')
                            setAddingCategory(false)
                          }
                        }}
                        placeholder="Nom de la catégorie"
                        disabled={saving}
                      />
                      <button
                        type="button"
                        className={styles.categoryValidateBtn}
                        onClick={commitNewCategory}
                        disabled={saving || !newCategoryDraft.trim()}
                      >
                        Valider
                      </button>
                    </div>,
                    document.body
                  )}
              </div>
              {iaCategoriesActive && (
                <div className={styles.categoryIaWrap}>
                  <button
                    type="button"
                    className={styles.iaBtn}
                    onClick={handleGenerateCategories}
                    disabled={saving}
                    title={
                      generatingCategories
                        ? 'Annuler la génération'
                        : 'Générer des catégories avec l’IA'
                    }
                    aria-label={
                      generatingCategories
                        ? 'Annuler la génération des catégories'
                        : 'Générer des catégories avec l’IA'
                    }
                  >
                    {generatingCategories ? (
                      <Loader2 size={16} className={styles.iaSpin} />
                    ) : (
                      <Sparkles size={16} />
                    )}
                    <span>IA</span>
                  </button>
                </div>
              )}
            </div>
            {categoriesError && <p className={styles.error}>{categoriesError}</p>}
          </div>

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
                  ollamaAvailable ? `${styles.textarea} ${styles.textareaWithIa}` : styles.textarea
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
                      <Loader2 size={16} className={styles.iaSpin} />
                    ) : (
                      <Sparkles size={16} />
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
            disabled={saving || generatingAbstract || generatingCategories}
          >
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}
