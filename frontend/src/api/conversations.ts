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
  // Pagination metadata populated by the backend on read. With no query
  // params: message_count = messages.length, messages_offset = 0. With
  // ?limit / ?offset: messages is the requested window and these fields
  // describe it.
  message_count: number
  messages_offset: number
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
