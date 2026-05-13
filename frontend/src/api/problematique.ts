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

export async function saveProblematique(
  projectId: string,
  data: Problematique
): Promise<Problematique> {
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
