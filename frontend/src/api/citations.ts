import { allLlmHeaders } from './llm'

/** One ranked text snippet returned by the semantic citation search. */
export interface CitationHit {
  chunk_id: string
  text: string
  chunk_index: number
  chunk_total: number
  /** Cosine-style score in [0, 1] — 1 means an exact embedding match. */
  similarity: number
  stem: string
  filename: string
  title: string
  author: string
  year: string
}

/** Optional metadata filters narrowing the citation search. */
export interface CitationSearchFilters {
  stem?: string
  author?: string
  category?: string
}

/** A single chunk, as returned by the "show more context" endpoint. */
export interface ChunkInfo {
  id: string
  chunk_index: number
  word_count: number
  text: string
}

/**
 * Run a semantic search over the project's indexed chunks. The query string
 * is embedded server-side, so LLM provider headers must travel with the
 * request (same as `api/chat.ts`).
 */
export async function searchCitations(
  projectId: string,
  query: string,
  filters: CitationSearchFilters = {},
  limit = 20,
  strict = false,
  signal?: AbortSignal
): Promise<CitationHit[]> {
  const res = await fetch(`/api/projects/${projectId}/citations/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...allLlmHeaders() },
    body: JSON.stringify({ query, limit, strict, ...filters }),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.results
}

/**
 * Fetch the window of chunks around a hit (`[index - radius, index + radius]`)
 * — backs the per-result "Voir plus de contexte" expander.
 *
 * No LLM headers here: this endpoint is a plain Chroma `.get()` with no
 * embedding step, unlike `searchCitations`.
 */
export async function getCitationContext(
  projectId: string,
  stem: string,
  chunkIndex: number,
  radius = 2,
  signal?: AbortSignal
): Promise<ChunkInfo[]> {
  const params = new URLSearchParams({
    stem,
    chunk_index: String(chunkIndex),
    radius: String(radius),
  })
  const res = await fetch(`/api/projects/${projectId}/citations/context?${params}`, {
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.chunks
}
