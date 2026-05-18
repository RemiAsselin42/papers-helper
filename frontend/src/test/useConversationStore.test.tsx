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
  last_variants: [],
  last_variant_index: 0,
  message_count: 0,
  messages_offset: 0,
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

  it('persist() appends new messages when pinned (tail-loaded chat flow)', async () => {
    const { calls } = stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
      () => jsonResponse(summary({ id: 'a', message_count: 2 })),
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a', message_count: 2 })]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.load('a')
    })
    await act(async () => {
      await result.current.persist({
        provider: 'ollama',
        model: 'llama3',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      })
    })

    // Append (POST /messages) instead of full-replace PUT on the second
    // persist call; the client only holds a window of the conversation now.
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'GET', 'POST', 'GET'])
    expect(calls[2].url).toContain('/conversations/a/messages')
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

  it('addVariant posts the regenerated content to the variants endpoint', async () => {
    const variantState = {
      last_variants: ['orig', 'regen'],
      last_variant_index: 1,
      message_count: 2,
      updated_at: '',
    }
    const { calls } = stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
      () => jsonResponse(variantState),
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.load('a')
    })

    let returned: typeof variantState | undefined
    await act(async () => {
      returned = await result.current.addVariant('regen')
    })

    expect(returned).toEqual(variantState)
    expect(calls[2].init?.method).toBe('POST')
    expect(calls[2].url).toContain('/conversations/a/messages/last/variants')
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({ content: 'regen' })
    // The summary list is refreshed afterwards.
    expect(calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'GET', 'POST', 'GET'])
  })

  it('selectVariant PUTs the chosen index to the variant endpoint', async () => {
    const variantState = {
      last_variants: ['orig', 'regen'],
      last_variant_index: 0,
      message_count: 2,
      updated_at: '',
    }
    const { calls } = stubFetchSequence([
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
      () => jsonResponse(conversation({ id: 'a' })),
      () => jsonResponse(variantState),
      () => jsonResponse<ConversationSummary[]>([summary({ id: 'a' })]),
    ])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.load('a')
    })

    let returned: typeof variantState | undefined
    await act(async () => {
      returned = await result.current.selectVariant(0)
    })

    expect(returned).toEqual(variantState)
    expect(calls[2].init?.method).toBe('PUT')
    expect(calls[2].url).toContain('/conversations/a/messages/last/variant')
    expect(JSON.parse(calls[2].init?.body as string)).toEqual({ index: 0 })
  })

  it('addVariant / selectVariant reject when no conversation is pinned', async () => {
    stubFetchSequence([() => jsonResponse<ConversationSummary[]>([])])
    const { result } = renderHook(() => useConversationStore('proj-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await expect(result.current.addVariant('x')).rejects.toThrow()
    await expect(result.current.selectVariant(0)).rejects.toThrow()
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
