import { readSseLines } from '../utils/sse'
import { ollamaHeaders } from './health'
import { getStoredOllamaModel, llmHeaders, type LLMProvider } from './llm'

const DONE_SENTINEL = '[DONE]'

/**
 * Calls /condense with prompt + stems + model. The backend decides between
 * full-doc, single-stem map-reduce, and multi-stem map-reduce based on the
 * doc size and the chosen provider's context window. The response is an SSE
 * stream of {token: string} payloads ending with [DONE].
 *
 * Always forwards the stored Ollama model (X-Ollama-Model). The backend uses
 * it for the map step when the chosen provider is external and the doc
 * exceeds 70% of its context — Ollama runs locally so it's "free" to fan out.
 */
export function streamCondense(
  projectId: string,
  prompt: string,
  stems: string[],
  model: string,
  signal?: AbortSignal,
  provider?: LLMProvider
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(ollamaHeaders() as Record<string, string>),
    ...(provider ? llmHeaders(provider) : {}),
  }
  const ollamaModel = getStoredOllamaModel()
  if (ollamaModel) headers['X-Ollama-Model'] = ollamaModel
  return fetch(`/api/projects/${projectId}/condense`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, stems, model }),
    signal,
  })
}

/**
 * Progress events emitted by the backend during a /condense run. The phase
 * progression is one of:
 *   start → (generating | map → reduce | map* → reduce* → global_reduce)
 *
 * - `start`: initial dispatch — `strategy` tells the UI what to expect.
 * - `generating`: full-doc strategy, single LLM call about to begin.
 * - `map`: a chunk has just finished pre-reduction. `done` ≤ `total`.
 * - `reduce`: per-stem reduce starting (final reduce in single-stem mode).
 * - `global_reduce`: multi-stem global synthesis starting.
 *
 * For multi-stem runs, `stem`, `stem_index`, and `stems_total` accompany
 * `map` and `reduce` events to let the UI show "document N/M" context.
 */
export interface CondenseProgress {
  phase: 'start' | 'generating' | 'map' | 'reduce' | 'global_reduce'
  strategy?: 'full' | 'map_reduce_single' | 'map_reduce_multi'
  done?: number
  total?: number
  stem?: string
  stem_index?: number
  stems_total?: number
}

/**
 * Drains the /condense SSE stream. `onToken` receives reduce-phase tokens to
 * append to the visible output; `onProgress` (optional) receives phase /
 * counter updates so the UI can render an advancement panel for long
 * map-reduce runs. Re-throws provider error events; swallows only SyntaxError
 * from malformed lines.
 */
export async function consumeCondenseStream(
  body: ReadableStream<Uint8Array>,
  onToken: (token: string) => void,
  onProgress?: (progress: CondenseProgress) => void
): Promise<void> {
  await readSseLines(body, (raw) => {
    if (raw === DONE_SENTINEL) return true
    try {
      const evt = JSON.parse(raw) as {
        token?: string
        error?: string
        progress?: CondenseProgress
      }
      if (evt.error) throw new Error(evt.error)
      if (typeof evt.token === 'string') onToken(evt.token)
      if (evt.progress && onProgress) onProgress(evt.progress)
    } catch (parseErr) {
      if (parseErr instanceof SyntaxError) return
      throw parseErr
    }
  })
}
