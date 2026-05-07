export interface OllamaModelStatus {
  name: string
  available: boolean
}

export interface HealthData {
  status: 'ok'
  ollama: 'connected' | 'unavailable'
  ollama_models: OllamaModelStatus[]
  storage: 'accessible' | 'inaccessible'
}

export const OLLAMA_URL_KEY = 'ollamaBaseUrl'

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

export async function checkHealth(ollamaUrl?: string): Promise<HealthData> {
  const params = ollamaUrl ? `?ollama_url=${encodeURIComponent(ollamaUrl)}` : ''
  const res = await fetch(`/health${params}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
