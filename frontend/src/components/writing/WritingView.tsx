import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  List,
  Loader2,
  Quote,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { getStoredOllamaModel } from '../../api/llm'
import type { CitationHit } from '../../api/citations'
import {
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  renameDoc,
  saveDoc,
  type CitationRef,
  type WritingDoc,
  type WritingDocSummary,
} from '../../api/writing'
import { formatReference } from '../citations/citationReference'
import { Skeleton } from '../layout/Skeleton'
import { DocumentEditor } from './DocumentEditor'
import { GenerationPanel } from './GenerationPanel'
import { CitationPicker } from './CitationPicker'
import { WritingDocList } from './WritingDocList'
import { WritingTitleEditor } from './WritingTitleEditor'
import styles from './WritingView.module.scss'

interface Props {
  projectId: string
  /** Generation is gated on Ollama; the editor itself never is. */
  ollamaAvailable: boolean
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const SAVE_DEBOUNCE_MS = 800

function citationMarker(hit: CitationHit): string {
  const who = hit.author || hit.title || hit.filename || hit.stem
  return hit.year ? `${who}, ${hit.year}` : who
}

/**
 * The "Aide à la rédaction" view: a per-project collection of named free-form
 * documents (mirrors the chat conversations UX). A slide-in panel selects the
 * document; the single tiptap editor edits it; generation inserts a passage at
 * the cursor.
 */
export function WritingView({ projectId, ollamaAvailable }: Props) {
  const [docs, setDocs] = useState<WritingDocSummary[]>([])
  const [currentDoc, setCurrentDoc] = useState<WritingDoc | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [panelLoading, setPanelLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [genPanelOpen, setGenPanelOpen] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [refsOpen, setRefsOpen] = useState(false)

  const editorRef = useRef<Editor | null>(null)
  const docRef = useRef<WritingDoc | null>(null)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const savingRef = useRef(false)
  const rerunRef = useRef(false)

  const model = getStoredOllamaModel()

  // ── Loading ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    listDocs(projectId)
      .then(async (list) => {
        if (cancelled) return
        setDocs(list)
        if (list.length > 0) {
          const doc = await getDoc(projectId, list[0].id)
          if (cancelled) return
          setCurrentDoc(doc)
          docRef.current = doc
          setTitleDraft(doc.title)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Échec du chargement')
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  // ── Saving (debounced, in-flight guarded) ───────────────────────────────────
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }
    const doc = docRef.current
    if (!doc) return
    if (savingRef.current) {
      rerunRef.current = true
      return
    }
    savingRef.current = true
    setSaveState('saving')
    try {
      await saveDoc(projectId, doc.id, {
        title: doc.title,
        content_html: doc.content_html,
        citations: doc.citations,
      })
      setSaveState('saved')
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
      if (rerunRef.current) {
        rerunRef.current = false
        void flushSave()
      }
    }
  }, [projectId])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined
      void flushSave()
    }, SAVE_DEBOUNCE_MS)
  }, [flushSave])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current)
        void flushSave()
      }
    }
  }, [flushSave])

  const applyDocChange = useCallback(
    (patch: Partial<WritingDoc>) => {
      const base = docRef.current
      if (!base) return
      const next = { ...base, ...patch }
      docRef.current = next
      setCurrentDoc(next)
      scheduleSave()
    },
    [scheduleSave]
  )

  // ── Document selection ──────────────────────────────────────────────────────
  function selectLoadedDoc(doc: WritingDoc) {
    docRef.current = doc
    setCurrentDoc(doc)
    setTitleDraft(doc.title)
    setGenPanelOpen(false)
  }

  async function handleSelect(id: string) {
    setPanelOpen(false)
    if (id === currentDoc?.id) return
    await flushSave()
    try {
      selectLoadedDoc(await getDoc(projectId, id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec du chargement du texte')
    }
  }

  async function handleNew() {
    setPanelOpen(false)
    await flushSave()
    try {
      const doc = await createDoc(projectId)
      setDocs((ds) => [
        { id: doc.id, title: doc.title, created_at: doc.created_at, updated_at: doc.updated_at },
        ...ds,
      ])
      selectLoadedDoc(doc)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la création du texte')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteDoc(projectId, id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec de la suppression')
      return
    }
    const remaining = docs.filter((d) => d.id !== id)
    setDocs(remaining)
    if (currentDoc?.id === id) {
      if (remaining.length > 0) {
        try {
          selectLoadedDoc(await getDoc(projectId, remaining[0].id))
        } catch {
          setCurrentDoc(null)
          docRef.current = null
        }
      } else {
        setCurrentDoc(null)
        docRef.current = null
      }
    }
  }

  async function handleRename(id: string, title: string) {
    try {
      await renameDoc(projectId, id, title)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec du renommage')
      return
    }
    setDocs((ds) => ds.map((d) => (d.id === id ? { ...d, title } : d)))
    if (docRef.current?.id === id) {
      applyDocChange({ title })
      setTitleDraft(title)
    }
  }

  function commitTitle() {
    if (!currentDoc) return
    const next = titleDraft.trim()
    if (!next || next === currentDoc.title) {
      setTitleDraft(currentDoc.title)
      return
    }
    applyDocChange({ title: next })
    setDocs((ds) => ds.map((d) => (d.id === currentDoc.id ? { ...d, title: next } : d)))
  }

  function togglePanel() {
    setPanelOpen((open) => {
      const next = !open
      if (next) {
        setPanelLoading(true)
        listDocs(projectId)
          .then(setDocs)
          .catch(() => {})
          .finally(() => setPanelLoading(false))
      }
      return next
    })
  }

  // ── Insertions ──────────────────────────────────────────────────────────────
  function handleInsertGenerated(html: string) {
    editorRef.current?.chain().focus().insertContent(html).run()
    setGenPanelOpen(false)
  }

  function removeCitation(chunkId: string) {
    const doc = docRef.current
    if (!doc) return
    applyDocChange({ citations: doc.citations.filter((c) => c.chunk_id !== chunkId) })
  }

  function handlePickCitation(hit: CitationHit) {
    setShowPicker(false)
    const editor = editorRef.current
    const doc = docRef.current
    if (!editor || !doc) return
    editor
      .chain()
      .focus()
      .insertContent(` (${citationMarker(hit)})`)
      .run()
    const ref: CitationRef = {
      chunk_id: hit.chunk_id,
      stem: hit.stem,
      filename: hit.filename,
      title: hit.title,
      author: hit.author,
      year: hit.year,
      chunk_index: hit.chunk_index,
    }
    // The bibliography lists *sources*, not passages — citing the same source
    // in several places counts as one reference. Dedupe by stem (the source
    // identifier), falling back to chunk_id when no stem is available.
    const key = (c: CitationRef) => c.stem || c.chunk_id
    if (!doc.citations.some((c) => key(c) === key(ref))) {
      applyDocChange({ citations: [...doc.citations, ref] })
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loadingList) {
    return <WritingViewSkeleton />
  }

  const genDisabled = !currentDoc || !ollamaAvailable || !model
  const genTitle = !ollamaAvailable
    ? 'Ollama indisponible'
    : !model
      ? 'Sélectionnez un modèle Ollama'
      : undefined

  return (
    <div className={styles.wrapper}>
      {panelOpen && (
        <button
          type="button"
          className={styles.backdrop}
          aria-label="Fermer le panneau"
          onClick={() => setPanelOpen(false)}
        />
      )}
      <div className={`${styles.panel} ${panelOpen ? styles.panelOpen : ''}`}>
        <button
          type="button"
          className={styles.panelClose}
          onClick={() => setPanelOpen(false)}
          aria-label="Fermer le panneau"
          title="Fermer"
        >
          <X size={20} />
        </button>
        <WritingDocList
          docs={docs}
          loading={panelLoading}
          currentId={currentDoc?.id ?? null}
          onSelect={handleSelect}
          onNew={handleNew}
          onDelete={handleDelete}
          onRename={handleRename}
        />
      </div>

      <div className={styles.root}>
        <div className={styles.toolbar}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${panelOpen ? styles.toolbarBtnActive : ''}`}
            onClick={togglePanel}
            aria-label="Liste des textes"
            aria-pressed={panelOpen}
            title="Liste des textes"
          >
            <List size={20} />
          </button>
          <WritingTitleEditor
            value={titleDraft}
            currentTitle={currentDoc?.title ?? ''}
            onChange={setTitleDraft}
            onCommit={commitTitle}
            disabled={!currentDoc}
          />
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setShowPicker(true)}
            disabled={!currentDoc}
          >
            <Quote size={16} />
            Citer
          </button>
          <button
            type="button"
            className={`${styles.primaryBtn} ${genPanelOpen ? styles.primaryBtnActive : ''}`}
            onClick={() => setGenPanelOpen((o) => !o)}
            disabled={genDisabled}
            title={genTitle}
          >
            <Sparkles size={16} />
            Générer
          </button>
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Fermer">
              ×
            </button>
          </div>
        )}

        {currentDoc ? (
          <>
            <DocumentEditor
              key={currentDoc.id}
              initialHtml={currentDoc.content_html}
              docTitle={currentDoc.title}
              saveState={saveState}
              onChange={(html) => applyDocChange({ content_html: html })}
              onEditorReady={(editor) => {
                editorRef.current = editor
              }}
            />
            {currentDoc.citations.length > 0 && (
              <div className={styles.references}>
                <button
                  type="button"
                  className={styles.referencesToggle}
                  onClick={() => setRefsOpen((o) => !o)}
                  aria-expanded={refsOpen}
                >
                  {refsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className={styles.referencesTitle}>
                    Références citées ({currentDoc.citations.length})
                  </span>
                </button>
                {refsOpen && (
                  <ul>
                    {currentDoc.citations.map((c) => (
                      <li key={c.chunk_id} className={styles.refItem}>
                        <span>{formatReference(c)}</span>
                        <button
                          type="button"
                          className={styles.refDelete}
                          onClick={() => removeCitation(c.chunk_id)}
                          aria-label="Supprimer la référence"
                          title="Supprimer la référence"
                        >
                          <Trash2 size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {genPanelOpen && (
              <GenerationPanel
                projectId={projectId}
                docId={currentDoc.id}
                onInsert={handleInsertGenerated}
                onClose={() => setGenPanelOpen(false)}
              />
            )}
            <div className={styles.statusRow}>
              <SaveIndicator state={saveState} />
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <FileText size={28} />
            <p>Aucun texte pour ce projet.</p>
            <button type="button" className={styles.primaryBtn} onClick={handleNew}>
              <FileText size={16} />
              Nouveau texte
            </button>
          </div>
        )}
      </div>

      {showPicker && currentDoc && (
        <CitationPicker
          projectId={projectId}
          onPick={handlePickCitation}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') {
    return (
      <span className={styles.save}>
        <Loader2 size={14} className={styles.spin} />
        Enregistrement…
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <span className={styles.save}>
        <Check size={14} />
        Enregistré
      </span>
    )
  }
  if (state === 'error') {
    return <span className={`${styles.save} ${styles.saveErr}`}>Échec de l'enregistrement</span>
  }
  return null
}

/** Cold-load placeholder: mirrors the toolbar + editor silhouette. */
function WritingViewSkeleton() {
  return (
    <div className={styles.wrapper}>
      <div className={styles.root}>
        <div className={styles.toolbar} aria-hidden>
          <Skeleton width={42} height={42} />
          <Skeleton height={42} className={styles.toolbarTitleSkeleton} />
          <Skeleton width={90} height={36} />
          <Skeleton width={108} height={36} />
        </div>
        <div className={styles.editorSkeleton} aria-hidden>
          <Skeleton width="45%" height={22} />
          <Skeleton count={4} height={14} gap={12} />
          <Skeleton width="60%" height={14} />
        </div>
      </div>
    </div>
  )
}
