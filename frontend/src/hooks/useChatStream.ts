import { useEffect, useRef, useState } from 'react'
import type { LLMProvider } from '../api/llm'
import type { SourceInfo } from '../api/papers'
import { type ChatMessage, consumeChatTokenStream, streamChat } from '../api/chat'

export type StreamStatus = 'ok' | 'aborted' | 'error'

export type ChatLoadingState = 'initial' | 'older' | null

export interface StreamResult {
  status: StreamStatus
  messages: ChatMessage[]
  /**
   * The messages that were added during this `send()` call (typically the
   * user message and the streamed assistant reply). The caller should
   * hand this off to the persist layer and then call `window.markSynced()`
   * to acknowledge that these are now server-confirmed.
   */
  newMessages: ChatMessage[]
}

/**
 * Pagination + persistence state for the currently-loaded conversation
 * window. Separate from the core streaming surface so consumers can pass
 * just `chat.window` to components that handle scroll/load-older without
 * also exposing `send`/`abort`.
 */
export interface ChatWindow {
  /**
   * Index of `messages[0]` in the full conversation on the server. Greater
   * than zero when only the tail of the conversation is loaded locally; the
   * top-sentinel in `ChatMessages` uses this to decide whether more older
   * messages can be fetched.
   */
  offset: number
  /**
   * Count of leading messages in the local window that are confirmed
   * persisted on the server. Diverges from `messages.length` only between a
   * successful `send()` and a successful `markSynced()` — those few messages
   * are local-only until persist completes.
   */
  syncedCount: number
  /**
   * Replace the entire message window (used when loading a saved
   * conversation). `offset` is the index of `next[0]` in the full
   * conversation. `variants` / `variantIndex` seed the last message's
   * regeneration history when the loaded conversation carries one.
   */
  resetMessages: (
    next: ChatMessage[],
    offset?: number,
    variants?: string[],
    variantIndex?: number
  ) => void
  /** Prepend a window of older messages, shifting `offset` down. */
  prependOlder: (older: ChatMessage[]) => void
  /** Acknowledge that all local messages are now persisted on the server. */
  markSynced: () => void
}

/** Skeleton-loading state for initial fetch vs older-page fetch. */
export interface ChatLoad {
  state: ChatLoadingState
  begin: (kind: 'initial' | 'older') => void
  end: () => void
}

/**
 * Regeneration history of the last assistant message. `items` holds every
 * generated answer; `items[index]` mirrors `messages[-1].content`. Fewer
 * than two items means there is nothing to navigate.
 */
export interface ChatVariants {
  items: string[]
  index: number
  /** Switch the displayed variant of the last message. */
  select: (index: number) => void
  /**
   * Replace the local variant state with the server-authoritative result of
   * a persist call, mirroring the active variant into `messages[-1]`. Lets
   * the caller reconcile after `addVariant` / `selectVariant`.
   */
  sync: (items: string[], index: number) => void
}

export interface UseChatStream {
  messages: ChatMessage[]
  /** Pagination + sync metadata for the loaded conversation window. */
  window: ChatWindow
  /** UI loading state for the skeleton placeholder. */
  load: ChatLoad
  /** Regeneration history of the last assistant message. */
  variants: ChatVariants
  /** Reset to a brand-new empty chat. */
  clear: () => void
  input: string
  setInput: (s: string) => void
  streaming: boolean
  abort: () => void
  send: (
    projectId: string,
    text: string,
    model: string,
    mentions?: string[],
    provider?: LLMProvider,
    sources?: SourceInfo[]
  ) => Promise<StreamResult>
  /**
   * Re-run the request that produced the last assistant message and stream a
   * fresh reply over it. The stale answer is blanked first so the new stream
   * renders from scratch. No-op (returns `error`) if the last message isn't
   * an assistant reply.
   */
  regenerate: (
    projectId: string,
    model: string,
    mentions?: string[],
    provider?: LLMProvider,
    sources?: SourceInfo[]
  ) => Promise<StreamResult>
}

export function useChatStream(): UseChatStream {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesOffset, setMessagesOffset] = useState(0)
  const [syncedCount, setSyncedCount] = useState(0)
  const [loadingState, setLoadingState] = useState<ChatLoadingState>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [variantItems, setVariantItems] = useState<string[]>([])
  const [variantIndex, setVariantIndex] = useState(0)

  // Mirrors state for synchronous reads inside send() — React batches setters
  // and we need the just-committed values when computing slice ranges.
  const messagesRef = useRef<ChatMessage[]>([])
  const syncedCountRef = useRef(0)
  const variantItemsRef = useRef<string[]>([])
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function commit(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    const next = updater(messagesRef.current)
    messagesRef.current = next
    setMessages(next)
  }

  function setVariants(items: string[], index: number): void {
    variantItemsRef.current = items
    setVariantItems(items)
    setVariantIndex(index)
  }

  function resetMessages(
    next: ChatMessage[],
    offset: number = 0,
    variants: string[] = [],
    variantIdx: number = 0
  ): void {
    messagesRef.current = next
    setMessages(next)
    setMessagesOffset(offset)
    syncedCountRef.current = next.length
    setSyncedCount(next.length)
    setVariants(variants, variantIdx)
  }

  function prependOlder(older: ChatMessage[]): void {
    if (!older.length) return
    const next = [...older, ...messagesRef.current]
    messagesRef.current = next
    setMessages(next)
    setMessagesOffset((prev) => Math.max(0, prev - older.length))
    // Older window comes from the server → fully in sync.
    syncedCountRef.current = next.length
    setSyncedCount(next.length)
  }

  function beginLoad(kind: 'initial' | 'older'): void {
    setLoadingState(kind)
  }

  function endLoad(): void {
    setLoadingState(null)
  }

  function markSynced(): void {
    syncedCountRef.current = messagesRef.current.length
    setSyncedCount(messagesRef.current.length)
  }

  function clear(): void {
    messagesRef.current = []
    setMessages([])
    setMessagesOffset(0)
    syncedCountRef.current = 0
    setSyncedCount(0)
    setLoadingState(null)
    setVariants([], 0)
  }

  function abort(): void {
    abortRef.current?.abort()
  }

  /** Mirror `items[index]` into the last message's content. */
  function applyVariantContent(items: string[], index: number): void {
    if (index < 0 || index >= items.length) return
    commit((prev) => {
      const lastIdx = prev.length - 1
      if (lastIdx < 0) return prev
      const copy = [...prev]
      copy[lastIdx] = { ...copy[lastIdx], content: items[index] }
      return copy
    })
  }

  /** Switch the displayed variant of the last message. */
  function selectVariant(index: number): void {
    const items = variantItemsRef.current
    if (index < 0 || index >= items.length) return
    setVariantIndex(index)
    applyVariantContent(items, index)
  }

  /** Replace variant state with a server-authoritative result. */
  function syncVariants(items: string[], index: number): void {
    const safeIndex = items.length ? Math.min(Math.max(index, 0), items.length - 1) : 0
    setVariants(items, safeIndex)
    applyVariantContent(items, safeIndex)
  }

  /**
   * Open the chat stream for `context` and append every token into the
   * message at `targetIndex`. Shared by `send` (target = freshly-appended
   * placeholder) and `regenerate` (target = the existing last message).
   * Toggles `streaming` off and clears `abortRef` before returning.
   */
  async function streamInto(
    projectId: string,
    model: string,
    context: ChatMessage[],
    targetIndex: number,
    mentions: string[],
    provider: LLMProvider | undefined,
    sources: SourceInfo[]
  ): Promise<StreamStatus> {
    let status: StreamStatus = 'ok'
    abortRef.current = new AbortController()
    try {
      const res = await streamChat(
        projectId,
        model,
        context,
        abortRef.current.signal,
        mentions,
        provider,
        sources
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      await consumeChatTokenStream(res.body, (token) => {
        commit((prev) => {
          const copy = [...prev]
          copy[targetIndex] = {
            ...copy[targetIndex],
            content: copy[targetIndex].content + token,
          }
          return copy
        })
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        status = 'aborted'
      } else {
        status = 'error'
        const detail = (err as Error).message?.trim()
        const body = detail
          ? `⚠ Erreur lors de la génération : ${detail}`
          : '⚠ Erreur lors de la génération.'
        commit((prev) => {
          const copy = [...prev]
          copy[targetIndex] = { role: 'assistant', content: body }
          return copy
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
    return status
  }

  async function send(
    projectId: string,
    text: string,
    model: string,
    mentions: string[] = [],
    provider?: LLMProvider,
    sources: SourceInfo[] = []
  ): Promise<StreamResult> {
    const syncedBeforeSend = syncedCountRef.current
    const userMsg: ChatMessage = { role: 'user', content: text }
    const nextMessages = [...messagesRef.current, userMsg]
    commit(() => nextMessages)
    setInput('')
    setStreaming(true)
    // The new turn becomes the tail — any variants of the old last message
    // no longer apply (the conversation continued from the displayed one).
    setVariants([], 0)

    const assistantIndex = nextMessages.length
    commit((prev) => [...prev, { role: 'assistant', content: '' }])

    const status = await streamInto(
      projectId,
      model,
      nextMessages,
      assistantIndex,
      mentions,
      provider,
      sources
    )

    const finalMessages = messagesRef.current
    return {
      status,
      messages: finalMessages,
      newMessages: finalMessages.slice(syncedBeforeSend),
    }
  }

  async function regenerate(
    projectId: string,
    model: string,
    mentions: string[] = [],
    provider?: LLMProvider,
    sources: SourceInfo[] = []
  ): Promise<StreamResult> {
    const current = messagesRef.current
    const lastIndex = current.length - 1
    // Need at least one preceding (user) message and an assistant tail to
    // regenerate; anything else is a programming error in the caller.
    if (lastIndex < 1 || current[lastIndex].role !== 'assistant') {
      return { status: 'error', messages: current, newMessages: [] }
    }

    // Keep the answer being replaced — it becomes a navigable variant once
    // the new one lands (or is restored verbatim if regeneration fails).
    const previousContent = current[lastIndex].content

    setStreaming(true)
    // Blank the stale answer so the fresh stream renders from scratch
    // instead of appending onto the previous reply.
    commit((prev) => {
      const copy = [...prev]
      copy[lastIndex] = { role: 'assistant', content: '' }
      return copy
    })

    // Re-send the history up to (but excluding) the assistant message we're
    // replacing — it ends with the user turn that prompted the answer.
    const context = current.slice(0, lastIndex)
    const status = await streamInto(
      projectId,
      model,
      context,
      lastIndex,
      mentions,
      provider,
      sources
    )

    const finalMessages = messagesRef.current
    if (status === 'ok') {
      // Record the fresh answer as a new variant. The first regeneration
      // also seeds variant 0 with the answer we just replaced.
      const base = variantItemsRef.current.length
        ? variantItemsRef.current
        : [previousContent]
      const nextVariants = [...base, finalMessages[lastIndex].content]
      setVariants(nextVariants, nextVariants.length - 1)
      return {
        status,
        messages: finalMessages,
        newMessages: [finalMessages[lastIndex]],
      }
    }

    // Regeneration failed (error / abort) — restore the previous answer and
    // leave the variant history untouched.
    commit((prev) => {
      const copy = [...prev]
      copy[lastIndex] = { ...copy[lastIndex], content: previousContent }
      return copy
    })
    return { status, messages: messagesRef.current, newMessages: [] }
  }

  return {
    messages,
    window: {
      offset: messagesOffset,
      syncedCount,
      resetMessages,
      prependOlder,
      markSynced,
    },
    load: {
      state: loadingState,
      begin: beginLoad,
      end: endLoad,
    },
    variants: {
      items: variantItems,
      index: variantIndex,
      select: selectVariant,
      sync: syncVariants,
    },
    clear,
    input,
    setInput,
    streaming,
    abort,
    send,
    regenerate,
  }
}
