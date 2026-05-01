import { useRef, useState, useCallback, DragEvent } from 'react'
import styles from './DropZone.module.scss'

type Status = 'idle' | 'dragging' | 'loading' | 'error'
export type FileStatus = 'queued' | 'processing' | 'done' | 'error'

export interface FileState {
  filename: string
  status: FileStatus
  chunks?: number
  error?: string
}

interface DropZoneProps {
  onSuccess?: () => void
  onProgress?: (states: FileState[]) => void
}

export function DropZone({ onSuccess, onProgress }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileStatesRef = useRef<FileState[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const updateFile = useCallback((filename: string, patch: Partial<FileState>) => {
    fileStatesRef.current = fileStatesRef.current.map(f =>
      f.filename === filename ? { ...f, ...patch } : f
    )
    onProgress?.(fileStatesRef.current)
  }, [onProgress])

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    setStatus('dragging')
  }
  function onDragLeave(e: DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setStatus(s => s === 'dragging' ? 'idle' : s)
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf')
    if (dropped.length) upload(dropped)
    else setStatus('idle')
  }
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) upload(Array.from(e.target.files))
  }

  async function upload(target: File[]) {
    const abort = new AbortController()
    abortRef.current = abort
    const timeout = setTimeout(() => abort.abort(new DOMException('Upload timeout', 'TimeoutError')), 120_000)

    setStatus('loading')
    const initial: FileState[] = target.map(f => ({ filename: f.name, status: 'queued' }))
    fileStatesRef.current = initial
    onProgress?.(initial)

    const body = new FormData()
    for (const file of target) body.append('files', file)

    try {
      const res = await fetch('/api/papers/upload/stream', {
        method: 'POST',
        body,
        signal: abort.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      const reader = res.body.getReader()
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
          const event = JSON.parse(line.slice(6))

          if (event.type === 'start') {
            updateFile(event.filename, { status: 'processing' })
          } else if (event.type === 'result') {
            updateFile(event.filename, { status: 'done', chunks: event.chunks_indexed })
          } else if (event.type === 'error') {
            updateFile(event.filename, { status: 'error', error: event.error })
          } else if (event.type === 'done') {
            setStatus('idle')
            onSuccess?.()
          }
        }
      }
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
      : 'Glisser des PDFs ici, ou cliquer pour sélectionner'

  return (
    <div className={styles.wrapper}>
      <div
        className={`${styles.zone} ${isDragging ? styles.zoneActive : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !isLoading && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && !isLoading && inputRef.current?.click()}
        aria-label="Zone de dépôt de PDFs"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className={styles.input}
          onChange={onFileChange}
        />
        <p className={styles.hint}>{hintText}</p>
      </div>

      {status === 'error' && (
        <p className={styles.errorMsg}>{errorMessage}</p>
      )}

    </div>
  )
}
