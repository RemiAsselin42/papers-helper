import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStream } from '../hooks/useChatStream'

// Build a ReadableStream that emits the given SSE frames as Uint8Array chunks.
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

function frame(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n`
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useChatStream', () => {
  it('streams assistant tokens and returns ok with the final messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ token: 'Hel' }), frame({ token: 'lo' }), 'data: [DONE]\n']),
      })
    )

    const { result } = renderHook(() => useChatStream())

    let outcome: Awaited<ReturnType<typeof result.current.send>> | undefined
    await act(async () => {
      outcome = await result.current.send('proj-1', 'hi', 'llama3')
    })

    expect(outcome?.status).toBe('ok')
    expect(outcome?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
    ])
    expect(result.current.streaming).toBe(false)
    expect(result.current.input).toBe('')
  })

  it('replaces the placeholder with an error banner on provider error events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ error: 'rate-limited' })]),
      })
    )

    const { result } = renderHook(() => useChatStream())

    let outcome: Awaited<ReturnType<typeof result.current.send>> | undefined
    await act(async () => {
      outcome = await result.current.send('proj-1', 'hi', 'llama3')
    })

    expect(outcome?.status).toBe('error')
    const last = outcome?.messages.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.content).toContain('rate-limited')
  })

  it('reports aborted when the request is cancelled', async () => {
    // Build a stream that pends forever so abort wins the race.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )

    const { result } = renderHook(() => useChatStream())

    let promise: ReturnType<typeof result.current.send> | undefined
    act(() => {
      promise = result.current.send('proj-1', 'hi', 'llama3')
    })
    act(() => {
      result.current.abort()
    })
    const outcome = await promise!
    expect(outcome.status).toBe('aborted')
  })

  it('survives malformed SSE frames mixed with valid ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([
          frame({ token: 'A' }),
          'data: {not-json\n',
          frame({ token: 'B' }),
          'data: [DONE]\n',
        ]),
      })
    )

    const { result } = renderHook(() => useChatStream())
    let outcome: Awaited<ReturnType<typeof result.current.send>> | undefined
    await act(async () => {
      outcome = await result.current.send('proj-1', 'hi', 'llama3')
    })
    expect(outcome?.status).toBe('ok')
    expect(outcome?.messages.at(-1)?.content).toBe('AB')
  })

  it('clear() resets the message list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ token: 'x' }), 'data: [DONE]\n']),
      })
    )
    const { result } = renderHook(() => useChatStream())
    await act(async () => {
      await result.current.send('proj-1', 'hi', 'llama3')
    })
    expect(result.current.messages).toHaveLength(2)
    act(() => result.current.clear())
    expect(result.current.messages).toHaveLength(0)
  })

  it('window.resetMessages records the offset and marks the window as synced', () => {
    const { result } = renderHook(() => useChatStream())
    const loaded = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ]
    act(() => result.current.window.resetMessages(loaded, 50))
    expect(result.current.messages).toEqual(loaded)
    expect(result.current.window.offset).toBe(50)
    expect(result.current.window.syncedCount).toBe(2)
  })

  it('window.prependOlder shifts the offset down and keeps everything synced', () => {
    const { result } = renderHook(() => useChatStream())
    act(() =>
      result.current.window.resetMessages(
        [{ role: 'user' as const, content: 'tail' }],
        10
      )
    )
    act(() =>
      result.current.window.prependOlder([
        { role: 'user', content: 'older-1' },
        { role: 'assistant', content: 'older-2' },
      ])
    )
    expect(result.current.window.offset).toBe(8)
    expect(result.current.messages.map((m) => m.content)).toEqual([
      'older-1',
      'older-2',
      'tail',
    ])
    expect(result.current.window.syncedCount).toBe(3)
  })

  it('send() exposes only the new messages until window.markSynced is called', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ token: 'ok' }), 'data: [DONE]\n']),
      })
    )
    const { result } = renderHook(() => useChatStream())
    // Simulate landing on a conversation with one previous turn already in
    // sync with the server (syncedCount = 1).
    act(() =>
      result.current.window.resetMessages(
        [{ role: 'user' as const, content: 'previous' }],
        5
      )
    )

    let outcome: Awaited<ReturnType<typeof result.current.send>> | undefined
    await act(async () => {
      outcome = await result.current.send('proj-1', 'hi', 'llama3')
    })

    // newMessages contains ONLY the user + assistant produced this turn.
    expect(outcome?.newMessages.map((m) => m.content)).toEqual(['hi', 'ok'])
    // syncedCount has NOT advanced yet — caller must persist + markSynced.
    expect(result.current.window.syncedCount).toBe(1)
    act(() => result.current.window.markSynced())
    expect(result.current.window.syncedCount).toBe(3)
  })

  it('regenerate re-streams a fresh reply over the last assistant message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream([frame({ token: 'fresh ' }), frame({ token: 'answer' }), 'data: [DONE]\n']),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChatStream())
    act(() =>
      result.current.window.resetMessages(
        [
          { role: 'user' as const, content: 'question' },
          { role: 'assistant' as const, content: 'stale answer' },
        ],
        0
      )
    )

    let outcome: Awaited<ReturnType<typeof result.current.regenerate>> | undefined
    await act(async () => {
      outcome = await result.current.regenerate('proj-1', 'llama3')
    })

    expect(outcome?.status).toBe('ok')
    expect(result.current.messages).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'fresh answer' },
    ])
    expect(outcome?.newMessages).toEqual([{ role: 'assistant', content: 'fresh answer' }])
    // The stale assistant message is excluded from the re-sent context.
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.messages).toEqual([{ role: 'user', content: 'question' }])
    // The replaced answer is kept as variant 0, the fresh one as variant 1.
    expect(result.current.variants.items).toEqual(['stale answer', 'fresh answer'])
    expect(result.current.variants.index).toBe(1)
  })

  it('variants.select switches the displayed answer of the last message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ token: 'v2' }), 'data: [DONE]\n']),
      })
    )

    const { result } = renderHook(() => useChatStream())
    act(() =>
      result.current.window.resetMessages(
        [
          { role: 'user' as const, content: 'q' },
          { role: 'assistant' as const, content: 'v1' },
        ],
        0
      )
    )
    await act(async () => {
      await result.current.regenerate('proj-1', 'llama3')
    })
    expect(result.current.variants.items).toEqual(['v1', 'v2'])

    // Navigate back to the original answer.
    act(() => result.current.variants.select(0))
    expect(result.current.variants.index).toBe(0)
    expect(result.current.messages.at(-1)).toEqual({ role: 'assistant', content: 'v1' })

    // Out-of-range selections are ignored.
    act(() => result.current.variants.select(5))
    expect(result.current.variants.index).toBe(0)
  })

  it('regenerate restores the previous answer when the stream errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ error: 'boom' })]),
      })
    )

    const { result } = renderHook(() => useChatStream())
    act(() =>
      result.current.window.resetMessages(
        [
          { role: 'user' as const, content: 'q' },
          { role: 'assistant' as const, content: 'kept answer' },
        ],
        0
      )
    )

    let outcome: Awaited<ReturnType<typeof result.current.regenerate>> | undefined
    await act(async () => {
      outcome = await result.current.regenerate('proj-1', 'llama3')
    })

    expect(outcome?.status).toBe('error')
    // Failed regeneration leaves the original answer in place, no variants.
    expect(result.current.messages.at(-1)).toEqual({ role: 'assistant', content: 'kept answer' })
    expect(result.current.variants.items).toEqual([])
  })

  it('regenerate is a no-op when the last message is not an assistant reply', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useChatStream())
    act(() =>
      result.current.window.resetMessages([{ role: 'user' as const, content: 'hi' }], 0)
    )

    let outcome: Awaited<ReturnType<typeof result.current.regenerate>> | undefined
    await act(async () => {
      outcome = await result.current.regenerate('proj-1', 'llama3')
    })

    expect(outcome?.status).toBe('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('load.begin / load.end toggles the skeleton flag', () => {
    const { result } = renderHook(() => useChatStream())
    expect(result.current.load.state).toBeNull()
    act(() => result.current.load.begin('initial'))
    expect(result.current.load.state).toBe('initial')
    act(() => result.current.load.begin('older'))
    expect(result.current.load.state).toBe('older')
    act(() => result.current.load.end())
    expect(result.current.load.state).toBeNull()
  })
})
