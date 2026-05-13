import { ollamaHeaders } from './health'
import { allLlmHeaders, llmHeaders, plainTextHeader, type LLMProvider } from './llm'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function mentionsHeader(stems: string[]): Record<string, string> {
  if (!stems.length) return {}
  return { 'X-Chat-Mentions': stems.map((s) => encodeURIComponent(s)).join(',') }
}

export function streamChat(
  projectId: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  mentions: string[] = [],
  provider?: LLMProvider
): Promise<Response> {
  // When the caller supplies a provider (per-chat override), build headers
  // around it instead of the globally-stored provider. Ollama URL is always
  // forwarded so embedding fallback works regardless of the chat provider.
  const providerHeaders: Record<string, string> = provider
    ? { ...ollamaHeaders(), ...llmHeaders(provider) }
    : allLlmHeaders()
  return fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...providerHeaders,
      ...plainTextHeader(),
      ...mentionsHeader(mentions),
    },
    body: JSON.stringify({ model, messages }),
    signal,
  })
}
