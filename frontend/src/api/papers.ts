import { allLlmHeaders } from './llm'

export interface SourceInfo {
  stem: string
  filename: string
  chunk_total: number
  pdf_title: string
  author: string
  year: string
  source_type: 'pdf' | 'docx' | 'txt' | 'odt' | 'rtf' | 'html' | 'epub' | 'url' | 'document'
  authors_json: string
  publication: string
  doi: string
  abstract: string
  notes: string
  categories: string
  indexed: boolean
  index_error: string
}

export interface UpdateMetadataPayload {
  pdf_title?: string
  author?: string
  authors_json?: string
  year?: string
  publication?: string
  doi?: string
  abstract?: string
  notes?: string
  categories?: string
}

export async function listSources(projectId: string): Promise<SourceInfo[]> {
  const res = await fetch(`/api/projects/${projectId}/papers/`, {
    headers: allLlmHeaders(),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function deleteSource(projectId: string, stem: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/papers/${encodeURIComponent(stem)}`, {
    method: 'DELETE',
    headers: allLlmHeaders(),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function updateSourceMetadata(
  projectId: string,
  stem: string,
  payload: UpdateMetadataPayload
): Promise<SourceInfo> {
  const res = await fetch(`/api/projects/${projectId}/papers/${encodeURIComponent(stem)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...allLlmHeaders() },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function addUrlSource(
  projectId: string,
  url: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`/api/projects/${projectId}/papers/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...allLlmHeaders() },
    body: JSON.stringify({ url }),
    signal,
  })
}

export function reindexSource(
  projectId: string,
  stem: string,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(`/api/projects/${projectId}/papers/${encodeURIComponent(stem)}/reindex`, {
    method: 'POST',
    headers: allLlmHeaders(),
    signal,
  })
}
