import type { ChatMessage } from './chat'
import { allLlmHeaders, type LLMProvider } from './llm'

export interface ConversationSummary {
  id: string
  title: string
  provider: LLMProvider
  model: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface Conversation {
  id: string
  title: string
  provider: LLMProvider
  model: string
  created_at: string
  updated_at: string
  messages: ChatMessage[]
  // Regenerated answers of the last message, kept for left/right navigation.
  // `last_variants[last_variant_index]` mirrors `messages[-1].content`.
  // Empty when the last message was never regenerated.
  last_variants: string[]
  last_variant_index: number
  // Pagination metadata populated by the backend on read. With no query
  // params: message_count = messages.length, messages_offset = 0. With
  // ?limit / ?offset: messages is the requested window and these fields
  // describe it.
  message_count: number
  messages_offset: number
}

/** Variant state of a conversation's last message. */
export interface LastVariantsState {
  last_variants: string[]
  last_variant_index: number
  message_count: number
  updated_at: string
}

export interface LoadConversationOptions {
  limit?: number
  offset?: number
}

export interface ConversationWritePayload {
  title?: string
  provider: LLMProvider
  model: string
  messages: ChatMessage[]
}

function jsonHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json', ...allLlmHeaders() }
}

export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  const res = await fetch(`/api/projects/${projectId}/conversations/`, {
    headers: allLlmHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.status}`)
  return res.json()
}

export async function loadConversation(
  projectId: string,
  conversationId: string,
  opts: LoadConversationOptions = {}
): Promise<Conversation> {
  const qs = new URLSearchParams()
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (opts.offset !== undefined) qs.set('offset', String(opts.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}${suffix}`,
    { headers: allLlmHeaders() }
  )
  if (!res.ok) throw new Error(`Failed to load conversation: ${res.status}`)
  return res.json()
}

/**
 * Append messages to an existing conversation without sending the full
 * history. Used by the tail-loaded chat flow where the client only holds a
 * window of the conversation (a full-replace PUT would clobber older
 * messages the client never loaded).
 */
export async function appendMessages(
  projectId: string,
  conversationId: string,
  messages: ChatMessage[]
): Promise<ConversationSummary> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ messages }),
    }
  )
  if (!res.ok) throw new Error(`Failed to append messages: ${res.status}`)
  return res.json()
}

/**
 * Record a regenerated reply (its `content`) as a new variant of the
 * conversation's last message. The previous answer is kept (seeded as
 * variant 0 on the first call) so the UI can offer left/right navigation;
 * the new variant becomes active. The rest of the (windowed) history is
 * left untouched.
 */
export async function addLastVariant(
  projectId: string,
  conversationId: string,
  content: string
): Promise<LastVariantsState> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/last/variants`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ content }),
    }
  )
  if (!res.ok) throw new Error(`Failed to add variant: ${res.status}`)
  return res.json()
}

/** Switch which recorded variant of the last message is active. */
export async function selectLastVariant(
  projectId: string,
  conversationId: string,
  index: number
): Promise<LastVariantsState> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/last/variant`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ index }),
    }
  )
  if (!res.ok) throw new Error(`Failed to select variant: ${res.status}`)
  return res.json()
}

export async function createConversation(
  projectId: string,
  payload: ConversationWritePayload
): Promise<Conversation> {
  const res = await fetch(`/api/projects/${projectId}/conversations/`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`)
  return res.json()
}

export async function updateConversation(
  projectId: string,
  conversationId: string,
  payload: ConversationWritePayload
): Promise<Conversation> {
  const res = await fetch(`/api/projects/${projectId}/conversations/${conversationId}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Failed to update conversation: ${res.status}`)
  return res.json()
}

export async function renameConversation(
  projectId: string,
  conversationId: string,
  title: string
): Promise<Conversation> {
  const res = await fetch(`/api/projects/${projectId}/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Failed to rename conversation: ${res.status}`)
  return res.json()
}

export async function deleteConversation(projectId: string, conversationId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/conversations/${conversationId}`, {
    method: 'DELETE',
    headers: allLlmHeaders(),
  })
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`)
}
