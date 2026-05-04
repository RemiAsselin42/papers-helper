import { useRef, useState, useCallback, DragEvent } from 'react'
import { HelpCircle } from 'lucide-react'
import { addUrlSource } from '../api/projects'
import {
  ACCEPTED_INPUT_ATTR,
  isAcceptedDocument,
} from '../constants/acceptedFormats'
import { HelpModal } from './HelpModal'
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

}

interface DropZoneProps {
  projectId: string
  onSuccess?: () => void
  onProgress?: (states: FileState[]) => void
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      onEvent(JSON.parse(line.slice(6)))
    }
  }
}

export function DropZone({ projectId, onSuccess, onProgress }: DropZoneProps) {
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
    const abort = new AbortController()
    abortRef.current = abort
    const timeout = setTimeout(
      () => abort.abort(new DOMException('Upload timeout', 'TimeoutError')),
      120_000
    )

    setStatus('loading')

    const docFiles = target.filter((f) => isAcceptedDocument(f) || isZipFile(f))

    const initial: FileState[] = docFiles.map((f) => ({ filename: f.name, status: 'queued' }))
    fileStatesRef.current = initial
    onProgress?.(initial)

    if (docFiles.length === 0) {
      clearTimeout(timeout)
      abortRef.current = null
      setStatus('idle')
      return
    }

    const body = new FormData()
    for (const file of docFiles) body.append('files', file)

    try {
      const res = await fetch(`/api/projects/${projectId}/papers/upload/stream`, {
        method: 'POST',
        body,
        signal: abort.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      await readSseStream(res.body, (event) => {
        if (event.type === 'start') {
          upsertFile(event.filename as string, { status: 'processing' })
        } else if (event.type === 'result') {
          if ('extracted_count' in event) {
            upsertFile(event.filename as string, {
              status: 'done',
              extracted_count: event.extracted_count as number,
            })
          } else if ('items_parsed' in event) {
            upsertFile(event.filename as string, {
              status: 'done',
              items_parsed: event.items_parsed as number,
            })
          } else {
            upsertFile(event.filename as string, {
              status: 'done',
              chunks: event.chunks_indexed as number,
            })
          }
        } else if (event.type === 'error') {
          upsertFile(event.filename as string, { status: 'error', error: event.error as string })
        } else if (event.type === 'done') {
          setStatus('idle')
          onSuccess?.()
        }
      })
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
    setStatus('loading')
    const initial: FileState[] = [{ filename: url, status: 'queued' }]
    fileStatesRef.current = initial
    onProgress?.(initial)

    const abort = new AbortController()
    abortRef.current = abort
    const timeout = setTimeout(
      () => abort.abort(new DOMException('Timeout', 'TimeoutError')),
      60_000
    )

    try {
      const res = await addUrlSource(projectId, url, abort.signal)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      await readSseStream(res.body, (event) => {
        if (event.type === 'start') {
          upsertFile(event.filename as string, { status: 'processing' })
        } else if (event.type === 'result') {
          upsertFile(event.filename as string, {
            status: 'done',
            chunks: event.chunks_indexed as number,
          })
        } else if (event.type === 'error') {
          upsertFile(event.filename as string, { status: 'error', error: event.error as string })
        } else if (event.type === 'done') {
          setStatus('idle')
          onSuccess?.()
        }
      })
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
          onClick={(e) => { e.stopPropagation(); setShowHelp(true) }}
          aria-label="Aide sur les formats supportés"
          title="Formats supportés et conseils"
          tabIndex={-1}
        >
          <HelpCircle size={14} />
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
