import { ollamaHeaders } from './health'

export async function listModels(): Promise<string[]> {
  const res = await fetch('/api/models', { headers: ollamaHeaders() })
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`)
  return res.json()
}
