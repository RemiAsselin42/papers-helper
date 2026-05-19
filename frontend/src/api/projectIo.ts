/**
 * Export / import d'un projet complet sous forme d'archive `.zip`.
 * Permet de transférer un projet entre plusieurs PC en local.
 */
import { type ProjectInfo } from './projects'

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback
  const match = /filename="?([^"]+)"?/.exec(header)
  return match ? match[1] : fallback
}

/** Télécharge l'archive `.zip` du projet. `includeVectors` embarque le vector
 * store ChromaDB (import instantané) ou non (archive légère, à réindexer). */
export async function exportProject(projectId: string, includeVectors: boolean): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/export?include_vectors=${includeVectors}`)
  if (!res.ok) throw new Error(`Échec de l'export : ${res.status}`)
  const blob = await res.blob()
  const filename = filenameFromDisposition(
    res.headers.get('content-disposition'),
    'projet.papers.zip'
  )
  triggerDownload(blob, filename)
}

export type ImportMode = 'auto' | 'replace' | 'duplicate'

/** `conflict` : un projet du même ID existe déjà — l'appelant doit relancer
 * `importProject` avec le mode `replace` ou `duplicate`. */
export type ImportResult =
  | { kind: 'ok'; project: ProjectInfo }
  | { kind: 'conflict'; id: string; name: string }

export async function importProject(file: File, mode: ImportMode = 'auto'): Promise<ImportResult> {
  const body = new FormData()
  body.append('file', file)
  const res = await fetch(`/api/projects/import?mode=${mode}`, { method: 'POST', body })
  if (res.status === 409) {
    const detail = (await res.json().catch(() => ({})))?.detail ?? {}
    return { kind: 'conflict', id: detail.id ?? '', name: detail.name ?? '' }
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(
      typeof detail?.detail === 'string' ? detail.detail : `Échec de l'import : ${res.status}`
    )
  }
  return { kind: 'ok', project: await res.json() }
}
