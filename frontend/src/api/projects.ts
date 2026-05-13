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
