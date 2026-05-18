import { useCallback, useEffect, useRef, useState } from 'react'
import { listSources, updateSourceMetadata } from '../api/papers'
import { generateAbstractForStem, generateCategoriesFromAbstract } from '../utils/enrich'
import { canRunIA } from '../utils/providerConfig'

export type EnrichPhase =
  | 'pending'
  | 'abstract'
  | 'categories'
  | 'done'
  | 'skipped'
  | 'error'

export interface EnrichState {
  phase: EnrichPhase
  /** French message — only set when phase === 'error'. */
  error?: string
}

interface QueueItem {
  stem: string
  hasAbstract: boolean
  hasCategories: boolean
}

/**
 * Sequential auto-enrichment queue: for each stem dequeued, runs the missing
 * IA generations one at a time — the abstract via /condense map-reduce, then
 * the categories via a single /categorize call on that abstract — and patches
 * the source metadata. A single concurrent generation is enforced —
 * Ollama serves both the embedding pipeline (during indexing) and the map
 * step (during condense), so parallel requests starve each other.
 *
 * `paused` defers all dequeues. The caller sets it to true while a batch
 * upload is in flight so embedding requests (during indexing) and chat
 * requests (during condense) don't hit Ollama simultaneously — that
 * combination saturates the daemon and causes embedding timeouts. Items
 * keep accumulating during the pause and drain in order when released.
 *
 * The caller passes the `has_*` flags from the SSE `result` event so we
 * don't need a round-trip to read the sidecar before deciding what to
 * generate.
 *
 * `onMetadataPatched` fires after every successful metadata PATCH so the
 * caller can refresh dependent views (the source list, an open metadata
 * modal) as enrichment lands — not only once the whole queue drains.
 */
export function useAutoEnrich(
  projectId: string,
  ollamaHealthy: boolean,
  paused: boolean = false,
  onMetadataPatched?: () => void
) {
  const queueRef = useRef<QueueItem[]>([])
  const runningRef = useRef(false)
  // Stem of the item currently being enriched, so `cancelStem` knows whether
  // to abort the in-flight run or just drop a queued entry.
  const runningStemRef = useRef<string | null>(null)
  const pausedRef = useRef(paused)
  const abortRef = useRef<AbortController | null>(null)
  // Stems the caller cancelled (source deleted). Once cancelled, no further
  // state writes land for that stem — keeps the toast free of stale entries.
  const cancelledRef = useRef<Set<string>>(new Set())
  // Always holds the live projectId so an in-flight run (whose closure
  // captured an older one) can detect a mid-run project switch.
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  // Held in a ref so an inline `onMetadataPatched` callback doesn't churn
  // `runNext`'s identity (which would re-arm the queue effects every render).
  const onPatchedRef = useRef(onMetadataPatched)
  onPatchedRef.current = onMetadataPatched
  const [states, setStates] = useState<Record<string, EnrichState>>({})

  const setState = useCallback((stem: string, next: EnrichState) => {
    if (cancelledRef.current.has(stem)) return
    setStates((prev) => ({ ...prev, [stem]: next }))
  }, [])

  const runNext = useCallback(async () => {
    if (runningRef.current) return
    if (pausedRef.current) return
    const item = queueRef.current.shift()
    if (!item) return
    runningRef.current = true
    runningStemRef.current = item.stem

    // Pin the project this run belongs to. If the user switches projects
    // while a generation is awaiting, the resolved result must not be
    // patched into the new project — `stale()` guards every write.
    const runProjectId = projectId
    const stale = () => runProjectId !== projectIdRef.current

    const readiness = canRunIA(ollamaHealthy)
    if (!readiness.ok) {
      // Provider went away between enqueue and dequeue — surface the reason
      // so the toast can show it instead of silently dropping the item.
      setState(item.stem, { phase: 'error', error: readiness.reason })
      runningRef.current = false
      void runNext()
      return
    }

    if (item.hasAbstract && item.hasCategories) {
      setState(item.stem, { phase: 'skipped' })
      runningRef.current = false
      void runNext()
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      // Categories are derived from the abstract — track its text so the
      // categories step can reuse it without re-summarising the document.
      let abstractText = ''

      if (!item.hasAbstract) {
        setState(item.stem, { phase: 'abstract' })
        abstractText = await generateAbstractForStem({
          projectId: runProjectId,
          stem: item.stem,
          model: readiness.model,
          provider: readiness.provider,
          signal: controller.signal,
        })
        if (stale()) throw new DOMException('project switched', 'AbortError')
        await updateSourceMetadata(runProjectId, item.stem, { abstract: abstractText })
        onPatchedRef.current?.()
      }

      if (!item.hasCategories) {
        setState(item.stem, { phase: 'categories' })
        // Abstract pre-existed (BibTeX) and wasn't generated this run — fetch
        // it so the categorisation has its input text.
        if (!abstractText) {
          const sources = await listSources(runProjectId)
          abstractText = sources.find((s) => s.stem === item.stem)?.abstract ?? ''
        }
        if (abstractText.trim()) {
          const categories = await generateCategoriesFromAbstract({
            projectId: runProjectId,
            abstract: abstractText,
            model: readiness.model,
            provider: readiness.provider,
            signal: controller.signal,
          })
          if (stale()) throw new DOMException('project switched', 'AbortError')
          await updateSourceMetadata(runProjectId, item.stem, {
            categories: categories.join(', '),
          })
          onPatchedRef.current?.()
        }
      }

      setState(item.stem, { phase: 'done' })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // The caller (project switch / unmount) aborted on purpose. Don't
        // mark as error — the run was simply cancelled.
        setState(item.stem, { phase: 'skipped' })
      } else {
        const msg = (err as Error).message?.trim() || 'Erreur de génération.'
        setState(item.stem, { phase: 'error', error: msg })
      }
    } finally {
      abortRef.current = null
      runningRef.current = false
      runningStemRef.current = null
      void runNext()
    }
  }, [ollamaHealthy, projectId, setState])

  /**
   * Cancel enrichment for a stem — call this when its source is deleted.
   * Drops a queued item, or aborts the generation if it is the running one,
   * and clears its toast entry. Prevents a deleted source from being
   * re-patched (which would resurrect an orphan metadata sidecar) and from
   * flashing a spurious "error" once the PATCH 404s.
   */
  const cancelStem = useCallback((stem: string) => {
    cancelledRef.current.add(stem)
    queueRef.current = queueRef.current.filter((q) => q.stem !== stem)
    if (runningStemRef.current === stem) abortRef.current?.abort()
    setStates((prev) => {
      if (!(stem in prev)) return prev
      const next = { ...prev }
      delete next[stem]
      return next
    })
  }, [])

  const enqueueStem = useCallback(
    (stem: string, flags: { hasAbstract: boolean; hasCategories: boolean }) => {
      // Skip immediately if nothing to do — keeps the toast clean (no
      // transient pending → skipped flash for fully-metadata'd imports).
      if (flags.hasAbstract && flags.hasCategories) return
      queueRef.current.push({ stem, ...flags })
      setState(stem, { phase: 'pending' })
      void runNext()
    },
    [runNext, setState]
  )

  // Switching projects (or unmount) cancels any in-flight run; queued items
  // for the old project would patch the wrong dataset otherwise.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      queueRef.current = []
      runningRef.current = false
      runningStemRef.current = null
      cancelledRef.current.clear()
    }
  }, [projectId])

  // Mirror `paused` into a ref so the runNext closure always sees the latest
  // value, then resume the queue as soon as the caller releases the pause.
  useEffect(() => {
    pausedRef.current = paused
    if (!paused) void runNext()
  }, [paused, runNext])

  return { enqueueStem, cancelStem, states }
}
