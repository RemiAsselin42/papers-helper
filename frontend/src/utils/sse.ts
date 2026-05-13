// Shared Server-Sent Events reader. Two framings appear in this codebase:
//   - Backend ingestion (upload / URL import / reindex) → `\n\n`-delimited frames.
//   - Backend chat stream → newline-delimited `data: …` lines with a `[DONE]` sentinel.
// `readSseEvents` handles the standard double-newline framing used everywhere
// except the chat token stream; `readSseLines` is the lower-level loop used by
// the chat stream where per-line control sentinels matter.

const DATA_PREFIX = 'data: '

export type SseLineHandler = (raw: string) => boolean | void | Promise<boolean | void>

/**
 * Reads an SSE response body line-by-line, calling `onLine` with the raw payload
 * (the substring after `data: `). Return `true` from `onLine` to stop the loop
 * early (used to honor the chat stream's `[DONE]` sentinel).
 */
export async function readSseLines(
  body: ReadableStream<Uint8Array>,
  onLine: SseLineHandler
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith(DATA_PREFIX)) continue
      const stop = await onLine(line.slice(DATA_PREFIX.length))
      if (stop === true) return
    }
  }
}

/**
 * Reads an SSE response body framed by blank lines (`\n\n`) and invokes
 * `onEvent` with the parsed JSON payload of each `data: …` frame. Frames that
 * fail to parse are silently skipped — the same forgiving behavior as the
 * previous per-call duplicates.
 */
export async function readSseEvents<T = unknown>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith(DATA_PREFIX)) continue
      try {
        onEvent(JSON.parse(line.slice(DATA_PREFIX.length)) as T)
      } catch {
        // Malformed JSON in an SSE frame is non-fatal — skip it.
      }
    }
  }
}

/** Drain an SSE body without parsing — used when the caller only cares about completion. */
export async function drainStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}
