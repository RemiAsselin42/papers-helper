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
