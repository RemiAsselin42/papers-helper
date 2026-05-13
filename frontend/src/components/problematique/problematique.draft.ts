import type { Problematique } from '../../api/problematique'

export type SubHyp = { _id: string; text: string }
export type HypoDraft = { _id: string; text: string; subs: SubHyp[] }
export type ApproachDraft = { _id: string; title: string; text: string }

export interface Draft {
  research_problem: string
  sub_research_problem: string | null
  hypotheses: HypoDraft[]
  planned_approaches: ApproachDraft[]
  expected_outcomes: string
}

export const EMPTY: Problematique = {
  research_problem: '',
  sub_research_problem: '',
  hypotheses: [],
  planned_approaches: [],
  expected_outcomes: '',
}

// Crypto.randomUUID is fine for client-only DOM keys — collision risk is nil
// and the id never reaches the API (we strip _id in draftToApi).
export function uid(): string {
  return crypto.randomUUID()
}

export function initDraft(data: Problematique): Draft {
  return {
    research_problem: data.research_problem,
    sub_research_problem: data.sub_research_problem || null,
    hypotheses: data.hypotheses.map((h) => ({
      _id: uid(),
      text: h.text,
      subs: h.sub_hypotheses.map((s) => ({ _id: uid(), text: s })),
    })),
    planned_approaches: data.planned_approaches.map((a) => ({
      _id: uid(),
      title: a.title,
      text: a.text,
    })),
    expected_outcomes: data.expected_outcomes,
  }
}

export function draftToApi(d: Draft): Problematique {
  return {
    research_problem: d.research_problem,
    sub_research_problem: d.sub_research_problem ?? '',
    hypotheses: d.hypotheses.map((h) => ({
      text: h.text,
      sub_hypotheses: h.subs.map((s) => s.text),
    })),
    planned_approaches: d.planned_approaches.map((a) => ({
      title: a.title,
      text: a.text,
    })),
    expected_outcomes: d.expected_outcomes,
  }
}
