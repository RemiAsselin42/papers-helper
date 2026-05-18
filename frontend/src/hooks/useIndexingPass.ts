import { useCallback, useRef, useState } from 'react'
import { allLlmHeaders } from '../api/llm'
import { readSseEvents } from '../utils/sse'

/** `paper.pdf` → `paper`. Mirrors the backend's `Path(filename).stem` so the
 * index-state keys line up with the stem used everywhere else (sidecars,
 * Chroma, the enrichment queue). Keying by stem — not filename — keeps URL
 * imports correlated: their toast row carries the URL as `filename`, but the
 * on-disk file (and so the index pass) uses a stem-derived name. */
function stemOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}

export type IndexPhase = 'queued' | 'indexing' | 'indexed' | 'failed'

export interface IndexState {
  phase: IndexPhase
  /** French message — only set when phase === 'failed'. */
  error?: string
}

interface IndexedFlags {
  hasAbstract: boolean
  hasCategories: boolean
}

interface IndexQueued {
  type: 'queued'
  filenames: string[]
}
interface IndexStart {
  type: 'start'
  filename: string
}
interface IndexResult {
  type: 'result'
  filename: string
  stem: string
  chunks_indexed: number
  indexed?: boolean
  index_error?: string
  has_abstract?: boolean
  has_categories?: boolean
}
interface IndexErrorEvent {
  type: 'error'
  filename: string
  error: string
}
interface IndexStartPass {
  type: 'start_index'
  total: number
}
interface IndexDone {
  type: 'done'
  total?: number
  failed?: number
}
interface IndexGraphUpdated {
  type: 'graph_updated'
}
type IndexEvent =
  | IndexQueued
  | IndexStart
  | IndexResult
  | IndexErrorEvent
  | IndexStartPass
  | IndexDone
  | IndexGraphUpdated

/**
 * Stage 2 of ingestion: the indexing pass. `start()` POSTs to
 * /papers/index/stream — the backend embeds every not-yet-indexed source file
 * into Chroma — and drains the SSE progress stream into `states` (keyed by
 * source stem, so the toast can correlate rows regardless of filename).
 *
 * For each file that lands in Chroma, `onIndexed` is invoked so the caller can
 * enqueue Stage 3 (auto-enrichment). The pass is idempotent: re-running it
 * only touches files still missing from Chroma, so `start()` can be called
 * after every import. A `start()` issued while a pass is running is coalesced
 * into a single re-run once the current pass finishes — files imported
 * mid-pass still get picked up.
 *
 * When a pass leaves failures behind (index errors in a big import are most
 * often transient Ollama timeouts), it auto-retries the still-pending files
 * a couple of times with a widening backoff before giving up.
 */

// Auto-retry budget for files that fail to index. Each retry only re-touches
// files still missing from Chroma, with a backoff so Ollama can recover.
const MAX_INDEX_RETRIES = 2
const RETRY_BACKOFF_MS = 4000

export function useIndexingPass(
  projectId: string,
  onIndexed: (stem: string, flags: IndexedFlags) => void,
  onProgress?: () => void,
  onGraphUpdated?: () => void
) {
  const [states, setStates] = useState<Record<string, IndexState>>({})
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const dirtyRef = useRef(false)

  // Runs one indexing pass; returns how many files failed (so the caller can
  // decide whether to retry). `reindexAll` targets /papers/reindex (drop +
  // re-embed every source — needed after an embedding-model / granularity
  // change); otherwise /papers/index/stream (only not-yet-indexed files).
  const runOnce = useCallback(
    async (reindexAll: boolean): Promise<number> => {
      let failures = 0
      try {
        const endpoint = reindexAll
          ? `/api/projects/${projectId}/papers/reindex`
          : `/api/projects/${projectId}/papers/index/stream`
        const res = await fetch(endpoint, { method: 'POST', headers: allLlmHeaders() })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        await readSseEvents<IndexEvent>(res.body, (ev) => {
          switch (ev.type) {
            case 'queued':
              setStates((prev) => {
                const next = { ...prev }
                for (const name of ev.filenames) {
                  const stem = stemOf(name)
                  // A retry pass re-queues files that failed last time — flip
                  // their badge back to "queued" so the UI shows the retry.
                  if (!next[stem] || next[stem].phase === 'failed') {
                    next[stem] = { phase: 'queued' }
                  }
                }
                return next
              })
              return
            case 'start':
              setStates((prev) => ({ ...prev, [stemOf(ev.filename)]: { phase: 'indexing' } }))
              return
            case 'result': {
              const indexed = ev.indexed ?? true
              if (!indexed) failures += 1
              setStates((prev) => ({
                ...prev,
                [ev.stem]: indexed
                  ? { phase: 'indexed' }
                  : { phase: 'failed', error: ev.index_error || 'Indexation échouée' },
              }))
              if (indexed && ev.stem) {
                onIndexed(ev.stem, {
                  hasAbstract: ev.has_abstract ?? false,
                  hasCategories: ev.has_categories ?? false,
                })
              }
              onProgress?.()
              return
            }
            case 'error':
              failures += 1
              setStates((prev) => ({
                ...prev,
                [stemOf(ev.filename)]: { phase: 'failed', error: ev.error },
              }))
              return
            case 'graph_updated':
              onGraphUpdated?.()
              return
          }
        })
      } catch {
        // Network / Chroma failure — mark every non-terminal row as failed so
        // the toast doesn't hang on a spinner forever. Counts as a failure so
        // the caller retries the whole pass.
        failures = Math.max(failures, 1)
        setStates((prev) => {
          const next = { ...prev }
          for (const [name, st] of Object.entries(next)) {
            if (st.phase === 'queued' || st.phase === 'indexing') {
              next[name] = { phase: 'failed', error: "Échec de l'indexation" }
            }
          }
          return next
        })
      }
      return failures
    },
    [projectId, onIndexed, onProgress, onGraphUpdated]
  )

  // `reindexAll` runs the full /papers/reindex once (no retry — a retry would
  // re-drop and re-embed everything). The default pending pass keeps the
  // failure-retry + mid-pass re-run behaviour.
  const start = useCallback(
    (opts?: { reindexAll?: boolean }) => {
      const reindexAll = opts?.reindexAll ?? false
      if (runningRef.current) {
        dirtyRef.current = true
        return
      }
      runningRef.current = true
      setRunning(true)
      void (async () => {
        try {
          if (reindexAll) setStates({})
          let attempt = 0
          for (;;) {
            dirtyRef.current = false
            const failures = await runOnce(reindexAll)
            // A `start()` fired during the pass (a new import) → re-run now.
            if (dirtyRef.current) continue
            // Otherwise retry the files that failed — index errors in a big
            // batch are usually transient Ollama timeouts. Back off longer
            // each attempt; the pass only re-touches still-pending files.
            if (!reindexAll && failures > 0 && attempt < MAX_INDEX_RETRIES) {
              attempt += 1
              await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt))
              continue
            }
            break
          }
        } finally {
          runningRef.current = false
          setRunning(false)
        }
      })()
    },
    [runOnce]
  )

  return { start, states, running }
}
