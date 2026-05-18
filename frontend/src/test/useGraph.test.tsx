import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGraph } from '../hooks/useGraph'
import type { GraphData } from '../api/graph'

const SAMPLE: GraphData = {
  version: 1,
  embed_model: 'nomic-embed-text',
  updated_at: '2026-05-14T00:00:00+00:00',
  nodes: [
    { id: 'paper:a', type: 'paper', label: 'Paper A', data: { stem: 'a' } },
    { id: 'author:smith_j', type: 'author', label: 'Smith, J', data: {} },
  ],
  edges: [{ source: 'paper:a', target: 'author:smith_j', type: 'authored_by', weight: 1 }],
  stats: { nodes: { paper: 1, author: 1 }, edges: { authored_by: 1 }, node_total: 2, edge_total: 1 },
  corrupt: false,
  source_count: 1,
  semantic_threshold: 0.6,
  community_count: 1,
}

function stubFetch(response: GraphData | { status: number }) {
  if ('status' in response) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: response.status,
      })
    )
  } else {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      })
    )
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useGraph', () => {
  it('returns nothing when projectId is null', () => {
    stubFetch(SAMPLE)
    const { result } = renderHook(() => useGraph(null, 0))
    expect(result.current.graph).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('fetches graph on mount and stores result', async () => {
    stubFetch(SAMPLE)
    const { result } = renderHook(() => useGraph('p1', 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.graph).toEqual(SAMPLE)
    expect(result.current.error).toBeNull()
  })

  it('refetches when refreshKey bumps', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE),
    })
    vi.stubGlobal('fetch', fetcher)
    const { result, rerender } = renderHook(
      ({ key }: { key: number }) => useGraph('p1', key),
      { initialProps: { key: 0 } }
    )
    await waitFor(() => expect(result.current.graph).not.toBeNull())
    expect(fetcher).toHaveBeenCalledTimes(1)

    rerender({ key: 1 })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })

  it('exposes a refresh() helper that triggers another fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SAMPLE),
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useGraph('p1', 0))
    await waitFor(() => expect(result.current.graph).not.toBeNull())
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })

  it('surfaces HTTP failures as an error message', async () => {
    stubFetch({ status: 500 })
    const { result } = renderHook(() => useGraph('p1', 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.graph).toBeNull()
    expect(result.current.error).toMatch(/500/)
  })
})
