import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIndexingPass } from '../hooks/useIndexingPass'

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { status: 200 })
}

// Fake timers so the retry backoff doesn't make the suite wait real seconds.
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useIndexingPass', () => {
  it('drains the index stream, enqueues each indexed stem, tracks per-file state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'start_index', total: 2 },
        { type: 'queued', filenames: ['a.pdf', 'b.pdf'] },
        { type: 'start', filename: 'a.pdf' },
        {
          type: 'result',
          filename: 'a.pdf',
          stem: 'a',
          chunks_indexed: 3,
          indexed: true,
          has_abstract: false,
          has_categories: true,
        },
        { type: 'start', filename: 'b.pdf' },
        {
          type: 'result',
          filename: 'b.pdf',
          stem: 'b',
          chunks_indexed: 0,
          indexed: false,
          index_error: 'boom',
        },
        { type: 'done', total: 1, failed: 1 },
      ])
    )

    const enqueued: Array<{ stem: string; hasAbstract: boolean; hasCategories: boolean }> = []
    const { result } = renderHook(() =>
      useIndexingPass('p1', (stem, flags) => enqueued.push({ stem, ...flags }))
    )

    await act(async () => {
      result.current.start()
      await vi.runAllTimersAsync()
    })

    expect(result.current.running).toBe(false)
    // Only the successfully-indexed stem is enqueued for enrichment.
    expect(enqueued).toEqual([{ stem: 'a', hasAbstract: false, hasCategories: true }])
    // States are keyed by stem, not filename.
    expect(result.current.states['a']?.phase).toBe('indexed')
    expect(result.current.states['b']?.phase).toBe('failed')
    expect(result.current.states['b']?.error).toBe('boom')
  })

  it('retries failed files and recovers on a later attempt', async () => {
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1
      // First pass fails the file; the retry pass succeeds.
      return sseResponse([
        { type: 'queued', filenames: ['a.pdf'] },
        { type: 'start', filename: 'a.pdf' },
        call === 1
          ? {
              type: 'result',
              filename: 'a.pdf',
              stem: 'a',
              chunks_indexed: 0,
              indexed: false,
              index_error: 'timeout',
            }
          : {
              type: 'result',
              filename: 'a.pdf',
              stem: 'a',
              chunks_indexed: 3,
              indexed: true,
            },
        { type: 'done' },
      ])
    })

    const { result } = renderHook(() => useIndexingPass('p1', () => {}))

    await act(async () => {
      result.current.start()
      await vi.runAllTimersAsync()
    })

    expect(call).toBeGreaterThanOrEqual(2)
    expect(result.current.states['a']?.phase).toBe('indexed')
    expect(result.current.running).toBe(false)
  })

  it('gives up after the retry budget when failures persist', async () => {
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1
      return new Response('', { status: 500 })
    })

    const { result } = renderHook(() => useIndexingPass('p1', () => {}))

    await act(async () => {
      result.current.start()
      await vi.runAllTimersAsync()
    })

    expect(result.current.running).toBe(false)
    // 1 initial pass + 2 retries (MAX_INDEX_RETRIES) = 3 attempts.
    expect(call).toBe(3)
  })

  it('forwards enrichment flags so a reindexed already-enriched doc is not re-enqueued', async () => {
    // A reindex restores each source's saved metadata, so a fully-enriched doc
    // comes back with has_abstract + has_categories both true.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        { type: 'start_reindex', total: 1 },
        { type: 'queued', filenames: ['a.pdf'] },
        { type: 'start', filename: 'a.pdf' },
        {
          type: 'result',
          filename: 'a.pdf',
          stem: 'a',
          chunks_indexed: 5,
          indexed: true,
          has_abstract: true,
          has_categories: true,
        },
        { type: 'done', total: 1, failed: 0 },
      ])
    )

    const enqueued: Array<{ stem: string; hasAbstract: boolean; hasCategories: boolean }> = []
    const { result } = renderHook(() =>
      useIndexingPass('p1', (stem, flags) => enqueued.push({ stem, ...flags }))
    )

    await act(async () => {
      result.current.start({ reindexAll: true })
      await vi.runAllTimersAsync()
    })

    // onIndexed still fires, but both flags are true — useAutoEnrich's
    // enqueueStem short-circuits on (hasAbstract && hasCategories), so the
    // enrichment never re-runs for an already-complete document.
    expect(enqueued).toEqual([{ stem: 'a', hasAbstract: true, hasCategories: true }])
  })

  it('targets /papers/reindex once (no retry) in reindexAll mode', async () => {
    let call = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1
      // A file fails — reindexAll must NOT retry (a retry re-drops everything).
      return sseResponse([
        { type: 'queued', filenames: ['a.pdf'] },
        {
          type: 'result',
          filename: 'a.pdf',
          stem: 'a',
          chunks_indexed: 0,
          indexed: false,
          index_error: 'boom',
        },
        { type: 'done' },
      ])
    })

    const { result } = renderHook(() => useIndexingPass('p1', () => {}))

    await act(async () => {
      result.current.start({ reindexAll: true })
      await vi.runAllTimersAsync()
    })

    expect(result.current.running).toBe(false)
    expect(call).toBe(1)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/papers/reindex')
    expect(result.current.states['a']?.phase).toBe('failed')
  })
})
