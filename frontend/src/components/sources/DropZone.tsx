import { useRef, useState, useCallback, DragEvent } from 'react'
import { HelpCircle } from 'lucide-react'
import { addUrlSource } from '../../api/papers'
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
}

interface DropZoneProps {
  projectId: string
  onSuccess?: () => void
  onProgress?: (states: FileState[]) => void
  onFileCompleted?: (filename: string) => void
}

// Bulk upload includes parsing time for the whole batch — give it twice the
// budget of a single-URL fetch. Both ceilings are deliberate: a stuck request
// kills the in-flight UI status, not the entire app.
const UPLOAD_TIMEOUT_MS = 120_000
const URL_IMPORT_TIMEOUT_MS = 60_000

// ── SSE event schema (matches backend/app/ingestion.py emissions) ─────────────
interface UploadStart {
  type: 'start'
  filename: string
}
interface UploadDocResult {
  type: 'result'
  filename: string
  chunks_indexed: number
  indexed?: boolean
  index_error?: string
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
  | UploadStart
  | UploadDocResult
  | UploadZipResult
  | UploadBibResult
  | UploadError
  | UploadDone

export function DropZone({ projectId, onSuccess, onProgress, onFileCompleted }: DropZoneProps) {
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
            const indexed = event.indexed ?? true
            upsertFile(event.filename, {
              status: 'done',
              chunks: event.chunks_indexed,
              indexed,
              index_error: event.index_error || undefined,
            })
            onFileCompleted?.(event.filename)
          }
          return
        case 'error':
          upsertFile(event.filename, { status: 'error', error: event.error })
          return
        case 'done':
          setStatus('idle')
          onSuccess?.()
          return
      }
    },
    [upsertFile, onFileCompleted, onSuccess]
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

  const hintText = isLoading
    ? 'Indexation en cours…'
    : isDragging
      ? 'Déposer ici'
      : `Glisser des fichiers ou cliquer pour sélectionner`

  return (
    <div className={styles.wrapper}>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      <div
        className={`${styles.zone} ${isDragging ? styles.zoneActive : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !isLoading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !isLoading && inputRef.current?.click()}
        aria-label="Zone de dépôt de fichiers"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_INPUT_ATTR + ',.zip'}
          multiple
          className={styles.input}
          onChange={onFileChange}
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
            disabled={isLoading}
            onKeyDown={(e) => e.key === 'Enter' && handleUrlSubmit()}
            aria-label="URL à importer"
          />
          <button
            className={styles.urlBtn}
            onClick={handleUrlSubmit}
            disabled={isLoading || !urlValue.trim()}
          >
            Importer
          </button>
        </div>
      </div>

      {status === 'error' && <p className={styles.errorMsg}>{errorMessage}</p>}
    </div>
  )
}
