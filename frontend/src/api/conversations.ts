import { allLlmHeaders, type LLMProvider } from './llm'
import type { ChatMessage } from './projects'

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
): Promise<Conversation> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    { headers: allLlmHeaders() },
  )
  if (!res.ok) throw new Error(`Failed to load conversation: ${res.status}`)
  return res.json()
}

export async function createConversation(
  projectId: string,
  payload: ConversationWritePayload,
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
  payload: ConversationWritePayload,
): Promise<Conversation> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    },
  )
  if (!res.ok) throw new Error(`Failed to update conversation: ${res.status}`)
  return res.json()
}

export async function renameConversation(
  projectId: string,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ title }),
    },
  )
  if (!res.ok) throw new Error(`Failed to rename conversation: ${res.status}`)
  return res.json()
}

export async function deleteConversation(
  projectId: string,
  conversationId: string,
): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/conversations/${conversationId}`,
    { method: 'DELETE', headers: allLlmHeaders() },
  )
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`)
}
