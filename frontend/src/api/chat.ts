import { detoxMentions, parseMentions } from '../utils/mentions'
import { ollamaHeaders } from './health'
import {
  allLlmHeaders,
  globalRagHeader,
  llmHeaders,
  neighborChunksHeader,
  plainTextHeader,
  type LLMProvider,
} from './llm'
import type { SourceInfo } from './papers'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function mentionsHeader(stems: string[]): Record<string, string> {
  if (!stems.length) return {}
  return { 'X-Chat-Mentions': stems.map((s) => encodeURIComponent(s)).join(',') }
}

/**
 * Rewrite each user message by replacing every `@Type/filename` token that
 * resolves to a known source with `« filename »`. The user-visible history
 * (in the chat store) keeps the `@` form; only the LLM-bound copy is
 * detoxified. Assistant and system messages pass through untouched.
 */
function detoxOutgoingMessages(
  messages: ChatMessage[],
  sources: SourceInfo[]
): ChatMessage[] {
  if (!sources.length) return messages
  return messages.map((m) => {
    if (m.role !== 'user') return m
    const parsed = parseMentions(m.content, sources)
    if (!parsed.length) return m
    return { ...m, content: detoxMentions(m.content, parsed) }
  })
}

export function streamChat(
  projectId: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  mentions: string[] = [],
  provider?: LLMProvider,
  sources: SourceInfo[] = []
): Promise<Response> {
  // When the caller supplies a provider (per-chat override), build headers
  // around it instead of the globally-stored provider. Ollama URL is always
  // forwarded so embedding fallback works regardless of the chat provider.
  const providerHeaders: Record<string, string> = provider
    ? { ...ollamaHeaders(), ...llmHeaders(provider) }
    : allLlmHeaders()
  const outgoing = detoxOutgoingMessages(messages, sources)
  return fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...providerHeaders,
      ...plainTextHeader(),
      ...neighborChunksHeader(),
      ...globalRagHeader(),
      ...mentionsHeader(mentions),
    },
    body: JSON.stringify({ model, messages: outgoing }),
    signal,
  })
}
