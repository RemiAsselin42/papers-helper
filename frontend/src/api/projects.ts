import { OLLAMA_URL_KEY } from './health'
import { allLlmHeaders, plainTextHeader } from './llm'

function ollamaHeaders(): HeadersInit {
  const url = localStorage.getItem(OLLAMA_URL_KEY)
  return url ? { 'X-Ollama-URL': url } : {}
}

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
}

export async function listSources(projectId: string): Promise<SourceInfo[]> {
  const res = await fetch(`/api/projects/${projectId}/papers/`, {
    headers: allLlmHeaders(),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function deleteSource(projectId: string, stem: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${projectId}/papers/${encodeURIComponent(stem)}`,
    { method: 'DELETE', headers: allLlmHeaders() }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
}

export async function updateSourceMetadata(
  projectId: string,
  stem: string,
  payload: UpdateMetadataPayload,
): Promise<SourceInfo> {
  const res = await fetch(
    `/api/projects/${projectId}/papers/${encodeURIComponent(stem)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...allLlmHeaders() },
      body: JSON.stringify(payload),
    }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function addUrlSource(projectId: string, url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/projects/${projectId}/papers/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...allLlmHeaders() },
    body: JSON.stringify({ url }),
    signal,
  })
}

export interface ProjectInfo {
  id: string
  name: string
  created_at: string
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const res = await fetch('/api/projects/')
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`)
  return res.json()
}

export async function createProject(name: string): Promise<ProjectInfo> {
  const res = await fetch('/api/projects/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail?.detail ?? `Failed to create project: ${res.status}`)
  }
  return res.json()
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete project: ${res.status}`)
}

export interface Hypothesis {
  text: string
  sub_hypotheses: string[]
}

export interface Approach {
  title: string
  text: string
}

export interface Problematique {
  research_problem: string
  sub_research_problem: string
  hypotheses: Hypothesis[]
  planned_approaches: Approach[]
  expected_outcomes: string
}

export async function getProblematique(projectId: string): Promise<Problematique> {
  const res = await fetch(`/api/projects/${projectId}/problematique`)
  if (!res.ok) throw new Error(`Failed to load problematique: ${res.status}`)
  return res.json()
}

export async function saveProblematique(projectId: string, data: Problematique): Promise<Problematique> {
  const res = await fetch(`/api/projects/${projectId}/problematique`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail?.detail ?? `Failed to save problematique: ${res.status}`)
  }
  return res.json()
}

export async function listModels(): Promise<string[]> {
  const res = await fetch('/api/models', { headers: ollamaHeaders() })
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`)
  return res.json()
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export function streamChat(
  projectId: string,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`/api/projects/${projectId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...allLlmHeaders(),
      ...plainTextHeader(),
    },
    body: JSON.stringify({ model, messages }),
    signal,
  })
}
