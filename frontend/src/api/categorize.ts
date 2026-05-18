import { ollamaHeaders } from './health'
import { llmHeaders, type LLMProvider } from './llm'

/**
 * Calls /categorize — a single one-shot LLM call that derives category labels
 * from a piece of text (the document's abstract). Unlike /condense it does no
 * Chroma read and no map-reduce, so it's cheap (~one call) and fast.
 *
 * Returns the raw LLM output; the caller parses it with `parseLlmStringArray`.
 */
export async function categorizeText(
  projectId: string,
  prompt: string,
  text: string,
  model: string,
  provider: LLMProvider,
  signal?: AbortSignal
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(ollamaHeaders() as Record<string, string>),
    ...llmHeaders(provider),
  }
  const res = await fetch(`/api/projects/${projectId}/categorize`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, text, model }),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { text: string }
  return data.text
}
