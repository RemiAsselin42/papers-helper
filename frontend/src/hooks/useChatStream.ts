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
   * conversation). `offset` is the index of `next[0]` in the full conversation.
   */
  resetMessages: (next: ChatMessage[], offset?: number) => void
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

export interface UseChatStream {
  messages: ChatMessage[]
  /** Pagination + sync metadata for the loaded conversation window. */
  window: ChatWindow
  /** UI loading state for the skeleton placeholder. */
  load: ChatLoad
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
}

export function useChatStream(): UseChatStream {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesOffset, setMessagesOffset] = useState(0)
  const [syncedCount, setSyncedCount] = useState(0)
  const [loadingState, setLoadingState] = useState<ChatLoadingState>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)

  // Mirrors state for synchronous reads inside send() — React batches setters
  // and we need the just-committed values when computing slice ranges.
  const messagesRef = useRef<ChatMessage[]>([])
  const syncedCountRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function commit(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    const next = updater(messagesRef.current)
    messagesRef.current = next
    setMessages(next)
  }

  function resetMessages(next: ChatMessage[], offset: number = 0): void {
    messagesRef.current = next
    setMessages(next)
    setMessagesOffset(offset)
    syncedCountRef.current = next.length
    setSyncedCount(next.length)
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
  }

  function abort(): void {
    abortRef.current?.abort()
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

    const assistantIndex = nextMessages.length
    commit((prev) => [...prev, { role: 'assistant', content: '' }])

    let status: StreamStatus = 'ok'
    abortRef.current = new AbortController()
    try {
      const res = await streamChat(
        projectId,
        model,
        nextMessages,
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
          copy[assistantIndex] = {
            ...copy[assistantIndex],
            content: copy[assistantIndex].content + token,
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
          copy[assistantIndex] = { role: 'assistant', content: body }
          return copy
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }

    const finalMessages = messagesRef.current
    return {
      status,
      messages: finalMessages,
      newMessages: finalMessages.slice(syncedBeforeSend),
    }
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
    clear,
    input,
    setInput,
    streaming,
    abort,
    send,
  }
}
