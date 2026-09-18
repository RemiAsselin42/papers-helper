import { getStoredOllamaModel } from './llm'

export interface OllamaModelStatus {
  name: string
  available: boolean
}

export interface HealthData {
  status: 'ok'
  ollama: 'connected' | 'unavailable'
  ollama_models: OllamaModelStatus[]
  ollama_url: string
  ollama_error: string | null
  storage: 'accessible' | 'inaccessible'
}

const OLLAMA_URL_KEY = 'ollamaBaseUrl'

export function getStoredOllamaUrl(): string | null {
  return localStorage.getItem(OLLAMA_URL_KEY)
}

export function setStoredOllamaUrl(url: string | null): void {
  if (url) {
    localStorage.setItem(OLLAMA_URL_KEY, url)
  } else {
    localStorage.removeItem(OLLAMA_URL_KEY)
  }
}

export function ollamaHeaders(): Record<string, string> {
  const url = localStorage.getItem(OLLAMA_URL_KEY)
  return url ? { 'X-Ollama-URL': url } : {}
}

export async function checkHealth(ollamaUrl?: string): Promise<HealthData> {
  const params = ollamaUrl ? `?ollama_url=${encodeURIComponent(ollamaUrl)}` : ''
  // The picked model is what the backend checks for generation; without one
  // it falls back to its env default.
  const model = getStoredOllamaModel()
  // Route through the /api proxy so this works regardless of whether the
  // dev server forwards /health directly.
  const res = await fetch(`/api/health${params}`, {
    headers: model ? { 'X-Ollama-Model': model } : {},
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
