import { useRef, useState, useCallback, DragEvent } from 'react'
import { HelpCircle } from 'lucide-react'
import { addUrlSource } from '../../api/papers'
import type { GraphUpdatedEvent } from '../../api/graph'
import { allLlmHeaders } from '../../api/llm'
import { ACCEPTED_INPUT_ATTR, isAcceptedDocument } from '../../constants/acceptedFormats'
import { readSseEvents } from '../../utils/sse'
import { HelpModal } from '../modals/HelpModal'
import styles from './DropZone.module.scss'

type Status = 'idle' | 'dragging' | 'loading' | 'error'
export type FileStatus = 'queued' | 'processing' | 'done' | 'error'

export interface FileState {
  filename: string
  status: FileStatus
  chunks?: number
  items_parsed?: number
  extracted_count?: number
  error?: string
  indexed?: boolean
  index_error?: string
  /** Only set on successful document indexing; lets the toast match
   * auto-enrichment progress (keyed by stem) to the right row. */
  stem?: string
  /** True for rows seeded by a settings-driven full reindex: the file was
   * already imported, so the toast shows a running spinner (not the green
   * "imported" check) until its index pass resolves. */
  reindexing?: boolean
}

export interface FileCompletedInfo {
  filename: string
  stem: string
  hasAbstract: boolean
  hasCategories: boolean
}

interface DropZoneProps {
  projectId: string
  onSuccess?: () => void
  onProgress?: (states: FileState[]) => void
  /** Fires for each successfully-imported document (skips ZIP/bib manifest
   * results). Stage 1 only saves + parses the file; the parent uses this to
   * refresh the source list as documents land. */
  onFileCompleted?: (info: FileCompletedInfo) => void
  /** Fires when the backend emits a `graph_updated` SSE event after a
   * successful index step. Parent uses this to refetch the graph view
   * without a polling interval. */
  onGraphUpdated?: () => void
  /** When true, all upload interactions (drop zone, file picker, URL input)
   * are disabled and `disabledReason` is shown instead of the usual hint. */
  disabled?: boolean
  disabledReason?: string
}

// Bulk upload includes parsing time for the whole batch — give it twice the
// budget of a single-URL fetch. Both ceilings are deliberate: a stuck request
// kills the in-flight UI status, not the entire app.
const UPLOAD_TIMEOUT_MS = 120_000
const URL_IMPORT_TIMEOUT_MS = 60_000

// ── SSE event schema (matches backend/app/ingestion.py emissions) ─────────────
interface UploadQueued {
  type: 'queued'
  filenames: string[]
}
interface UploadStart {
  type: 'start'
  filename: string
}
interface UploadDocResult {
  type: 'result'
  filename: string
  stem: string
  chunks_indexed: number
  indexed?: boolean
  index_error?: string
  has_abstract?: boolean
  has_categories?: boolean
}
interface UploadZipResult {
  type: 'result'
  filename: string
  extracted_count: number
}
interface UploadBibResult {
  type: 'result'
  filename: string
  items_parsed: number
}
interface UploadError {
  type: 'error'
  filename: string
  error: string
}
interface UploadDone {
  type: 'done'
}
type UploadEvent =
  | UploadQueued
  | UploadStart
  | UploadDocResult
  | UploadZipResult
  | UploadBibResult
  | UploadError
  | UploadDone
  | GraphUpdatedEvent

export function DropZone({
  projectId,
  onSuccess,
  onProgress,
  onFileCompleted,
  onGraphUpdated,
  disabled = false,
  disabledReason,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileStatesRef = useRef<FileState[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [showHelp, setShowHelp] = useState(false)

  const isZipFile = (f: File) => f.name.toLowerCase().endsWith('.zip')

  const upsertFile = useCallback(
    (filename: string, patch: Partial<FileState>) => {
      const exists = fileStatesRef.current.some((f) => f.filename === filename)
      if (exists) {
        fileStatesRef.current = fileStatesRef.current.map((f) =>
          f.filename === filename ? { ...f, ...patch } : f
        )
      } else {
        fileStatesRef.current = [...fileStatesRef.current, { filename, status: 'queued', ...patch }]
      }
      onProgress?.(fileStatesRef.current)
    },
    [onProgress]
  )

  const handleEvent = useCallback(
    (event: UploadEvent) => {
      switch (event.type) {
        case 'queued':
          // Hydrate the full resolved file list (post-ZIP-expansion, post-bib
          // discovery) upfront so users see every queued doc, not just the
          // few they explicitly selected. upsertFile is idempotent — existing
          // entries (selected files already in `queued`) keep their state.
          for (const name of event.filenames) upsertFile(name, { status: 'queued' })
          return
        case 'start':
          upsertFile(event.filename, { status: 'processing' })
          return
        case 'result':
          if ('extracted_count' in event) {
            upsertFile(event.filename, {
              status: 'done',
              extracted_count: event.extracted_count,
            })
          } else if ('items_parsed' in event) {
            upsertFile(event.filename, {
              status: 'done',
              items_parsed: event.items_parsed,
            })
          } else {
            // Stage 1 import only saves + parses — `indexed` is always false
            // here; Chroma embedding happens in the indexing pass afterwards.
            const indexed = event.indexed ?? false
            upsertFile(event.filename, {
              status: 'done',
              chunks: event.chunks_indexed,
              indexed,
              index_error: event.index_error || undefined,
              stem: event.stem,
            })
            onFileCompleted?.({
              filename: event.filename,
              stem: event.stem,
              hasAbstract: event.has_abstract ?? false,
              hasCategories: event.has_categories ?? false,
            })
          }
          return
        case 'error':
          upsertFile(event.filename, { status: 'error', error: event.error })
          return
        case 'graph_updated':
          onGraphUpdated?.()
          return
        case 'done':
          setStatus('idle')
          onSuccess?.()
          return
      }
    },
    [upsertFile, onFileCompleted, onGraphUpdated, onSuccess]
  )

  async function runImport(
    initial: FileState[],
    timeoutMs: number,
    action: (signal: AbortSignal) => Promise<Response>
  ): Promise<void> {
    const abort = new AbortController()
    abortRef.current = abort
    const timeout = setTimeout(
      () => abort.abort(new DOMException('Timeout', 'TimeoutError')),
      timeoutMs
    )

    setStatus('loading')
    fileStatesRef.current = initial
    onProgress?.(initial)

    try {
      const res = await action(abort.signal)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')
      await readSseEvents<UploadEvent>(res.body, handleEvent)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatus('idle')
        return
      }
      setErrorMessage(err instanceof Error ? err.message : 'Erreur inconnue')
      setStatus('error')
    } finally {
      clearTimeout(timeout)
      abortRef.current = null
    }
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    setStatus('dragging')
  }
  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setStatus((s) => (s === 'dragging' ? 'idle' : s))
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter(
      (f) => isAcceptedDocument(f) || isZipFile(f)
    )
    if (dropped.length) upload(dropped)
    else setStatus('idle')
  }
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) upload(Array.from(e.target.files))
  }

  async function upload(target: File[]) {
    const docFiles = target.filter((f) => isAcceptedDocument(f) || isZipFile(f))
    if (docFiles.length === 0) {
      setStatus('idle')
      return
    }

    const body = new FormData()
    for (const file of docFiles) body.append('files', file)
    const initial: FileState[] = docFiles.map((f) => ({ filename: f.name, status: 'queued' }))

    await runImport(initial, UPLOAD_TIMEOUT_MS, (signal) =>
      fetch(`/api/projects/${projectId}/papers/upload/stream`, {
        method: 'POST',
        headers: allLlmHeaders(),
        body,
        signal,
      })
    )
  }

  function isValidUrl(raw: string): boolean {
    try {
      const parsed = new URL(raw)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }

  async function handleUrlSubmit() {
    const url = urlValue.trim()
    if (!url) return

    if (!isValidUrl(url)) {
      setErrorMessage('URL invalide — doit commencer par http:// ou https://')
      setStatus('error')
      return
    }

    setUrlValue('')
    await runImport([{ filename: url, status: 'queued' }], URL_IMPORT_TIMEOUT_MS, (signal) =>
      addUrlSource(projectId, url, signal)
    )
  }

  const isDragging = status === 'dragging'
  const isLoading = status === 'loading'
  const interactive = !isLoading && !disabled

  const hintText = disabled
    ? (disabledReason ?? 'Importation indisponible.')
    : isLoading
      ? 'Importation en cours…'
      : isDragging
        ? 'Déposer ici'
        : `Glisser des fichiers ou cliquer pour sélectionner`

  return (
    <div className={styles.wrapper}>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      <div
        className={`${styles.zone} ${isDragging ? styles.zoneActive : ''} ${disabled ? styles.zoneDisabled : ''}`}
        onDragOver={interactive ? onDragOver : undefined}
        onDragLeave={interactive ? onDragLeave : undefined}
        onDrop={interactive ? onDrop : undefined}
        onClick={() => interactive && inputRef.current?.click()}
        role="button"
        tabIndex={interactive ? 0 : -1}
        aria-disabled={disabled || undefined}
        onKeyDown={(e) => e.key === 'Enter' && interactive && inputRef.current?.click()}
        aria-label="Zone de dépôt de fichiers"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_INPUT_ATTR + ',.zip'}
          multiple
          className={styles.input}
          onChange={onFileChange}
          disabled={disabled}
        />
        <button
          className={styles.helpBtn}
          onClick={(e) => {
            e.stopPropagation()
            setShowHelp(true)
          }}
          aria-label="Aide sur les formats supportés"
          title="Formats supportés et conseils"
          tabIndex={-1}
        >
          <HelpCircle size={16} />
          Aide
        </button>
        <p className={styles.hint}>{hintText}</p>
      </div>

      <div className={styles.urlSection}>
        <p className={styles.urlLabel}>Ou importer depuis une URL</p>
        <div className={styles.urlRow}>
          <input
            type="url"
            className={styles.urlInput}
            placeholder="https://…"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            disabled={isLoading || disabled}
            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
            aria-label="URL à importer"
          />
          <button
            className={styles.urlBtn}
            onClick={handleUrlSubmit}
            disabled={isLoading || disabled || !urlValue.trim()}
          >
            Importer
          </button>
        </div>
      </div>

      {status === 'error' && <p className={styles.errorMsg}>{errorMessage}</p>}
    </div>
  )
}
