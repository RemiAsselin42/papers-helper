import { useCallback, useEffect, useState } from 'react'
import {
  appendMessages,
  type Conversation,
  type ConversationSummary,
  type ConversationWritePayload,
  createConversation,
  deleteConversation,
  listConversations,
  loadConversation,
  type LoadConversationOptions,
  renameConversation,
} from '../api/conversations'
import type { ChatMessage } from '../api/chat'
import type { LLMProvider } from '../api/llm'

// Number of messages fetched per pagination request — used both for the
// initial tail load when opening a conversation and for the windows loaded
// when the user scrolls up. 30 leaves enough context above the fold to feel
// natural without trying to render long histories all at once.
export const CONVERSATION_PAGE_SIZE = 30

export interface PinnedConfig {
  id: string
  provider: LLMProvider
  model: string
}

export interface UseConversationStore {
  conversations: ConversationSummary[]
  loading: boolean
  pinned: PinnedConfig | null
  refresh: () => void
  /**
   * Load a conversation. Defaults to fetching only the tail
   * (`CONVERSATION_PAGE_SIZE` most recent messages) to keep the initial
   * payload small for long histories; pass `{limit: undefined}` explicitly
   * if you want the full conversation.
   */
  load: (id: string, opts?: LoadConversationOptions) => Promise<Conversation>
  /** Fetch an older window of messages from a pinned conversation. */
  loadOlder: (id: string, offset: number, limit: number) => Promise<Conversation>
  /** Reset to a new chat (no pinned conversation). */
  clear: () => void
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /**
   * Persist conversation changes. When `pinned` is set, `payload.messages`
   * is treated as **new messages to append** (matching the windowed-chat
   * flow); when no conversation is pinned yet, a new one is created with
   * the full payload as the seed history.
   */
  persist: (payload: Omit<ConversationWritePayload, 'title'>) => Promise<Conversation>
}

export function useConversationStore(projectId: string): UseConversationStore {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [pinned, setPinned] = useState<PinnedConfig | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    listConversations(projectId)
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(() => {
    setPinned(null)
    refresh()
  }, [projectId, refresh])

  const load = useCallback(
    async (
      id: string,
      opts: LoadConversationOptions = { limit: CONVERSATION_PAGE_SIZE }
    ): Promise<Conversation> => {
      const conv = await loadConversation(projectId, id, opts)
      setPinned({ id: conv.id, provider: conv.provider, model: conv.model })
      return conv
    },
    [projectId]
  )

  const loadOlder = useCallback(
    async (id: string, offset: number, limit: number): Promise<Conversation> => {
      // Older-page fetches MUST NOT touch `pinned` — the conversation is
      // already selected and the chat hook will prepend the result to its
      // existing window. Re-pinning would no-op but it's still a misleading
      // side-effect, so we use the raw API directly.
      return loadConversation(projectId, id, { offset, limit })
    },
    [projectId]
  )

  const clear = useCallback(() => {
    setPinned(null)
  }, [])

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await deleteConversation(projectId, id)
      } finally {
        setPinned((prev) => (prev?.id === id ? null : prev))
        refresh()
      }
    },
    [projectId, refresh]
  )

  const rename = useCallback(
    async (id: string, title: string): Promise<void> => {
      try {
        await renameConversation(projectId, id, title)
      } finally {
        refresh()
      }
    },
    [projectId, refresh]
  )

  const persist = useCallback(
    async (payload: Omit<ConversationWritePayload, 'title'>): Promise<Conversation> => {
      if (pinned) {
        // Append-only: the client doesn't hold the full history (tail-load
        // windowed view), so a full-replace PUT would destroy older
        // messages. The caller (chat hook) is responsible for passing only
        // the new messages since the last successful sync.
        const summary = await appendMessages(projectId, pinned.id, payload.messages)
        refresh()
        // The append endpoint only returns a summary; we synthesise the
        // shape callers expect. Messages stay client-side anyway.
        const conv: Conversation = {
          id: summary.id,
          title: summary.title,
          provider: summary.provider,
          model: summary.model,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          messages: payload.messages as ChatMessage[],
          message_count: summary.message_count,
          messages_offset: summary.message_count - payload.messages.length,
        }
        return conv
      }
      const conv = await createConversation(projectId, payload)
      setPinned({ id: conv.id, provider: conv.provider, model: conv.model })
      refresh()
      return conv
    },
    [pinned, projectId, refresh]
  )

  return {
    conversations,
    loading,
    pinned,
    refresh,
    load,
    loadOlder,
    clear,
    remove,
    rename,
    persist,
  }
}
