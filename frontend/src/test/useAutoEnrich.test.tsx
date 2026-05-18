import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoEnrich } from '../hooks/useAutoEnrich'

function sseResponse(payloads: unknown[]): Response {
  const chunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('llmProvider', 'ollama')
  localStorage.setItem('ollamaModel', 'llama3')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAutoEnrich', () => {
  it('skips items where both abstract and categories already exist', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: true, hasCategories: true })
    })

    // Both flags true → nothing enqueued, no states entry created.
    expect(result.current.states['doc1']).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('marks an item as error when the provider is no longer ready at dequeue', async () => {
    // No Ollama model stored → canRunIA fails.
    localStorage.removeItem('ollamaModel')
    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: false })
    })

    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('error')
    })
    expect(result.current.states['doc1']?.error).toMatch(/modèle Ollama/i)
  })

  it('runs abstract (/condense) then categories (/categorize) and finishes done', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/condense')) return sseResponse([{ token: 'short summary' }, '[DONE]'])
      if (u.includes('/categorize')) return jsonResponse({ text: '["A","B"]' })
      return jsonResponse({}) // PATCH metadata
    })

    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: false })
    })

    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('done')
    })
    // 4 calls: /condense + PATCH abstract + /categorize + PATCH categories.
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('derives categories from the existing abstract when only categories are missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url)
      const method = (init as RequestInit | undefined)?.method
      if (u.includes('/categorize')) return jsonResponse({ text: '["X"]' })
      if (method === 'PATCH') return jsonResponse({})
      // GET /papers/ — listSources, to fetch the pre-existing abstract.
      return jsonResponse([{ stem: 'doc1', abstract: 'an existing abstract' }])
    })

    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: true, hasCategories: false })
    })

    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('done')
    })
    // 3 calls: GET /papers/ (listSources) + /categorize + PATCH categories.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('only generates the abstract when categories already exist', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sseResponse([{ token: 'short summary' }, '[DONE]']))
      .mockResolvedValueOnce(jsonResponse({}))

    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: true })
    })

    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('done')
    })
    // Abstract only: /condense + PATCH.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('defers all generations while paused, then drains in order on release', async () => {
    let condenseCallCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/condense')) {
        condenseCallCount += 1
        return sseResponse([{ token: 'summary' }, '[DONE]'])
      }
      return jsonResponse({})
    })

    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useAutoEnrich('p1', true, paused),
      { initialProps: { paused: true } }
    )

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: true })
      result.current.enqueueStem('doc2', { hasAbstract: false, hasCategories: true })
    })

    // Both items should be queued as pending, no fetch yet.
    expect(result.current.states['doc1']?.phase).toBe('pending')
    expect(result.current.states['doc2']?.phase).toBe('pending')
    expect(condenseCallCount).toBe(0)

    // Release the pause: queue should drain.
    rerender({ paused: false })

    await waitFor(() => {
      expect(result.current.states['doc2']?.phase).toBe('done')
    })
    expect(condenseCallCount).toBe(2)
  })

  it('serialises multiple enqueues — never two generations in flight', async () => {
    let inFlight = 0
    let maxParallel = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.includes('/condense')) {
        inFlight += 1
        maxParallel = Math.max(maxParallel, inFlight)
        // Yield once so a second pending generate (if any) could race.
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return sseResponse([{ token: 'summary' }, '[DONE]'])
      }
      return jsonResponse({})
    })

    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      // Three docs with only the abstract missing → 3 condense calls + 3 patches.
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: true })
      result.current.enqueueStem('doc2', { hasAbstract: false, hasCategories: true })
      result.current.enqueueStem('doc3', { hasAbstract: false, hasCategories: true })
    })

    await waitFor(() => {
      expect(result.current.states['doc3']?.phase).toBe('done')
    })
    expect(maxParallel).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(6)
  })

  it('aborts the in-flight run and never patches when the project switches', async () => {
    const patchedProjects: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes('/condense')) {
        // Honour the abort signal like real fetch — switching projects
        // aborts the controller via the hook's cleanup effect.
        return new Promise<Response>((resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          const timer = setTimeout(
            () => resolve(sseResponse([{ token: 'short summary' }, '[DONE]'])),
            50
          )
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      // A PATCH — record which project it targeted.
      const m = u.match(/\/projects\/([^/]+)\/papers\//)
      if (m) patchedProjects.push(m[1])
      return jsonResponse({})
    })

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAutoEnrich(projectId, true),
      { initialProps: { projectId: 'p1' } }
    )

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: false })
    })

    // Wait until the abstract generation is genuinely in flight.
    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('abstract')
    })

    // Switch projects mid-run — the run must not patch either project.
    rerender({ projectId: 'p2' })

    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('skipped')
    })
    expect(patchedProjects).toEqual([])
  })

  it('cancelStem drops a queued source so it is never enriched', async () => {
    let condenseCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/condense')) {
        condenseCalls += 1
        return sseResponse([{ token: 'summary' }, '[DONE]'])
      }
      return jsonResponse({})
    })

    const { result, rerender } = renderHook(
      ({ paused }: { paused: boolean }) => useAutoEnrich('p1', true, paused),
      { initialProps: { paused: true } }
    )

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: true })
      result.current.enqueueStem('doc2', { hasAbstract: false, hasCategories: true })
    })
    act(() => {
      result.current.cancelStem('doc1')
    })

    // The cancelled stem leaves no toast entry behind.
    expect(result.current.states['doc1']).toBeUndefined()

    rerender({ paused: false })

    await waitFor(() => {
      expect(result.current.states['doc2']?.phase).toBe('done')
    })
    // Only doc2 was enriched — doc1 never reached /condense.
    expect(condenseCalls).toBe(1)
    expect(result.current.states['doc1']).toBeUndefined()
  })

  it('cancelStem aborts the running source without flashing an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/condense')) {
        // Honour the abort signal like real fetch.
        return new Promise<Response>((resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          const timer = setTimeout(
            () => resolve(sseResponse([{ token: 'summary' }, '[DONE]'])),
            50
          )
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      return jsonResponse({})
    })

    const { result } = renderHook(() => useAutoEnrich('p1', true))

    act(() => {
      result.current.enqueueStem('doc1', { hasAbstract: false, hasCategories: false })
    })
    await waitFor(() => {
      expect(result.current.states['doc1']?.phase).toBe('abstract')
    })

    act(() => {
      result.current.cancelStem('doc1')
    })

    // The aborted run must not resurrect the toast entry as 'skipped'/'error'.
    expect(result.current.states['doc1']).toBeUndefined()
    // Let the aborted generation settle — its catch must stay a no-op.
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current.states['doc1']).toBeUndefined()
  })
})
