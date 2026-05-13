import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ConversationSummary } from '../api/conversations'
import { useConversationStore } from '../hooks/useConversationStore'

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'c1',
  title: 'Untitled',
  provider: 'ollama',
  model: 'llama3',
  created_at: '',
  updated_at: '',
  message_count: 0,
  ...overrides,
})

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'c1',
  title: 'Untitled',
  provider: 'ollama',
  model: 'llama3',
  created_at: '',
  updated_at: '',
  messages: [],
  ...overrides,
})

interface FetchCall {
  url: string
  init?: RequestInit
}

function stubFetchSequence(responses: Array<() => Response | Promise<Response>>) {
  const calls: FetchCall[] = []
  const fn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected fetch: ${url}`)
    return Promise.resolve(next())
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

function jsonResponse<T>(body: T): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useConversationStore', () => {
  it('loads the conversation list on mount', async () => {
    stubFetchSequence([() => jsonResponse([summary({ id: 'a' }), summary({ id: 'b' })])])
    const { result } = renderHook(() => useConversationStore('proj-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.conversations.map((c) => c.id)).toEqual(['a', 'b'])
    expect(result.current.pinned).toBeNull()
  })

  it('falls back to an empty list when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')))
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.conversations).toEqual([])
  })

  it('pins a conversation after load()', async () => {
    stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a', provider: 'openai', model: 'gpt-4o' })),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.load('a')
    })

    expect(result.current.pinned).toEqual({ id: 'a', provider: 'openai', model: 'gpt-4o' })
  })

  it('persist() creates when no pin then refreshes the list', async () => {
    const { calls } = stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([]),
      () => jsonResponse(conversation({ id: 'new' })),
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'new' })]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.persist({ provider: 'ollama', model: 'llama3', messages: [] })
    })

    await waitFor(() => expect(result.current.pinned?.id).toBe('new'))
    // Three fetch calls so far: initial list, POST create, follow-up list.
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
  })

  it('persist() updates the existing conversation when pinned', async () => {
    const { calls } = stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
      () => jsonResponse(conversation({ id: 'a' })),
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.load('a')
    })
    await act(async () => {
      await result.current.persist({ provider: 'ollama', model: 'llama3', messages: [] })
    })

    // PUT (update) rather than POST (create) on the second persist call.
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'GET', 'PUT', 'GET'])
  })

  it('remove() unpins the deleted conversation', async () => {
    stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
      () => ({ ok: true, json: async () => ({}) }) as unknown as Response,
      () => jsonResponse<ConversationSummary[]>([]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.load('a')
    })
    await act(async () => {
      await result.current.remove('a')
    })

    expect(result.current.pinned).toBeNull()
  })

  it('clear() drops the current pin without touching the network', async () => {
    stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.load('a')
    })
    expect(result.current.pinned).not.toBeNull()

    act(() => result.current.clear())
    expect(result.current.pinned).toBeNull()
  })
})
