import { useCallback, useEffect, useState } from 'react'
import {
  type Conversation,
  type ConversationSummary,
  type ConversationWritePayload,
  createConversation,
  deleteConversation,
  listConversations,
  loadConversation,
  renameConversation,
  updateConversation,
} from '../api/conversations'
import type { LLMProvider } from '../api/llm'

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
  load: (id: string) => Promise<Conversation>
  /** Reset to a new chat (no pinned conversation). */
  clear: () => void
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** Create or update the active conversation based on whether `pinned` is set. */
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
    async (id: string): Promise<Conversation> => {
      const conv = await loadConversation(projectId, id)
      setPinned({ id: conv.id, provider: conv.provider, model: conv.model })
      return conv
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
      const conv = pinned
        ? await updateConversation(projectId, pinned.id, payload)
        : await createConversation(projectId, payload)
      setPinned({ id: conv.id, provider: conv.provider, model: conv.model })
      refresh()
      return conv
    },
    [pinned, projectId, refresh]
  )

  return { conversations, loading, pinned, refresh, load, clear, remove, rename, persist }
}
