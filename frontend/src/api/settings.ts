// Two-layer application settings (see backend/app/settings.py): global
// defaults persisted server-side, per-project nullable overrides, and the
// resolved effective values (project override ?? global default).

export type ChunkGranularity = 'precis' | 'equilibre' | 'rapide'

export const GRANULARITY_LABELS: Record<ChunkGranularity, string> = {
  precis: 'Précis',
  equilibre: 'Équilibré',
  rapide: 'Rapide',
}

/** Global defaults — every field always has a concrete value. */
export interface AppSettings {
  embed_model: string
  chunk_granularity: ChunkGranularity
  auto_enrich: boolean
}

/** Per-project overrides — a null field inherits the global default. */
export interface ProjectSettings {
  embed_model: string | null
  chunk_granularity: ChunkGranularity | null
  auto_enrich: boolean | null
}

export interface ResolvedSettings {
  embed_model: string
  chunk_granularity: ChunkGranularity
  max_chunk_chars: number
  auto_enrich: boolean
}

export interface ProjectSettingsBundle {
  overrides: ProjectSettings
  global_defaults: AppSettings
  resolved: ResolvedSettings
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export async function getGlobalSettings(): Promise<AppSettings> {
  const res = await fetch('/api/settings')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function saveGlobalSettings(settings: AppSettings): Promise<AppSettings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function getProjectSettings(projectId: string): Promise<ProjectSettingsBundle> {
  const res = await fetch(`/api/projects/${projectId}/settings`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function saveProjectSettings(
  projectId: string,
  overrides: ProjectSettings
): Promise<ProjectSettingsBundle> {
  const res = await fetch(`/api/projects/${projectId}/settings`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(overrides),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
