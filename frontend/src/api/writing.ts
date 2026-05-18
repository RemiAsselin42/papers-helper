import { readSseLines } from '../utils/sse'
import { ollamaHeaders } from './health'

const DONE_SENTINEL = '[DONE]'

/** Provenance of a citation inserted into a document — a record only. */
export interface CitationRef {
  chunk_id: string
  stem: string
  filename: string
  title: string
  author: string
  year: string
  chunk_index: number
}

/** One free-form writing document — a single named rich-text zone. */
export interface WritingDoc {
  id: string
  title: string
  content_html: string
  citations: CitationRef[]
  created_at: string
  updated_at: string
}

export interface WritingDocSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export async function listDocs(projectId: string): Promise<WritingDocSummary[]> {
  const res = await fetch(`/api/projects/${projectId}/writing/`)
  if (!res.ok) throw new Error(`Failed to list documents: ${res.status}`)
  return res.json()
}

export async function getDoc(projectId: string, docId: string): Promise<WritingDoc> {
  const res = await fetch(`/api/projects/${projectId}/writing/${docId}`)
  if (!res.ok) throw new Error(`Failed to load document: ${res.status}`)
  return res.json()
}

export async function createDoc(projectId: string, title?: string): Promise<WritingDoc> {
  const res = await fetch(`/api/projects/${projectId}/writing/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  })
  if (!res.ok) throw new Error(`Failed to create document: ${res.status}`)
  return res.json()
}

export async function saveDoc(
  projectId: string,
  docId: string,
  data: { title: string; content_html: string; citations: CitationRef[] }
): Promise<WritingDoc> {
  const res = await fetch(`/api/projects/${projectId}/writing/${docId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail?.detail ?? `Failed to save document: ${res.status}`)
  }
  return res.json()
}

export async function renameDoc(
  projectId: string,
  docId: string,
  title: string
): Promise<WritingDoc> {
  const res = await fetch(`/api/projects/${projectId}/writing/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Failed to rename document: ${res.status}`)
  return res.json()
}

export async function deleteDoc(projectId: string, docId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/writing/${docId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete document: ${res.status}`)
}

/**
 * Open the SSE stream that generates a passage via RAG + Ollama. v1 is
 * Ollama-only, so only the Ollama URL header travels with the request — no
 * `X-LLM-Provider` (the backend rejects external providers here).
 */
export function streamGenerate(
  projectId: string,
  docId: string,
  instructions: string,
  model: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`/api/projects/${projectId}/writing/${docId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaHeaders() },
    body: JSON.stringify({ instructions, model }),
    signal,
  })
}

/**
 * Drain the generation SSE stream, forwarding each `{token}` payload to
 * `onToken`. Re-throws backend `{error}` events; swallows only SyntaxError
 * from malformed frames.
 */
export async function consumeGenerateStream(
  body: ReadableStream<Uint8Array>,
  onToken: (token: string) => void
): Promise<void> {
  await readSseLines(body, (raw) => {
    if (raw === DONE_SENTINEL) return true
    try {
      const evt = JSON.parse(raw) as { token?: string; error?: string }
      if (evt.error) throw new Error(evt.error)
      if (typeof evt.token === 'string') onToken(evt.token)
    } catch (parseErr) {
      if (parseErr instanceof SyntaxError) return
      throw parseErr
    }
  })
}
