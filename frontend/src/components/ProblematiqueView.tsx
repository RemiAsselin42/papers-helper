import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { getProblematique, saveProblematique, type Problematique } from '../api/projects'
import styles from './ProblematiqueView.module.scss'

interface Props {
  projectId: string
}

type SubHyp = { _id: string; text: string }
type HypoDraft = { _id: string; text: string; subs: SubHyp[] }
type ApproachDraft = { _id: string; title: string; text: string }

interface Draft {
  research_problem: string
  sub_research_problem: string | null
  hypotheses: HypoDraft[]
  planned_approaches: ApproachDraft[]
  expected_outcomes: string
}

const EMPTY: Problematique = {
  research_problem: '',
  sub_research_problem: '',
  hypotheses: [],
  planned_approaches: [],
  expected_outcomes: '',
}

function uid() {
  return crypto.randomUUID()
}

function initDraft(data: Problematique): Draft {
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

function draftToApi(d: Draft): Problematique {
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

function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} />
}

export function ProblematiqueView({ projectId }: Props) {
  const [data, setData] = useState<Problematique | null>(null)
  const [draft, setDraft] = useState<Draft>(initDraft(EMPTY))
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setIsEditing(false)
    getProblematique(projectId)
      .then((d) => setData(d))
      .catch(console.error)
  }, [projectId])

  function handleEdit() {
    setDraft(initDraft(data ?? EMPTY))
    setIsEditing(true)
  }

  function handleCancel() {
    setSaveError(null)
    setIsEditing(false)
  }

  async function handleSave() {
    setIsSaving(true)
    setSaveError(null)
    try {
      const saved = await saveProblematique(projectId, draftToApi(draft))
      setData(saved)
      setIsEditing(false)
    } catch (err) {
      console.error(err)
      setSaveError(err instanceof Error ? err.message : "Erreur lors de l'enregistrement")
    } finally {
      setIsSaving(false)
    }
  }

  // ── Draft helpers ────────────────────────────────────────────────────────────

  const set = <K extends keyof Draft>(key: K, val: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: val }))

  function addHypothesis() {
    setDraft((d) => ({ ...d, hypotheses: [...d.hypotheses, { _id: uid(), text: '', subs: [] }] }))
  }
  function removeHypothesis(id: string) {
    setDraft((d) => ({ ...d, hypotheses: d.hypotheses.filter((h) => h._id !== id) }))
  }
  function setHypoText(id: string, text: string) {
    setDraft((d) => ({
      ...d,
      hypotheses: d.hypotheses.map((h) => (h._id === id ? { ...h, text } : h)),
    }))
  }
  function addSubHyp(hypoId: string) {
    setDraft((d) => ({
      ...d,
      hypotheses: d.hypotheses.map((h) =>
        h._id === hypoId ? { ...h, subs: [...h.subs, { _id: uid(), text: '' }] } : h
      ),
    }))
  }
  function removeSubHyp(hypoId: string, subId: string) {
    setDraft((d) => ({
      ...d,
      hypotheses: d.hypotheses.map((h) =>
        h._id === hypoId ? { ...h, subs: h.subs.filter((s) => s._id !== subId) } : h
      ),
    }))
  }
  function setSubHypText(hypoId: string, subId: string, text: string) {
    setDraft((d) => ({
      ...d,
      hypotheses: d.hypotheses.map((h) =>
        h._id === hypoId
          ? { ...h, subs: h.subs.map((s) => (s._id === subId ? { ...s, text } : s)) }
          : h
      ),
    }))
  }

  function addApproach() {
    setDraft((d) => ({
      ...d,
      planned_approaches: [...d.planned_approaches, { _id: uid(), title: '', text: '' }],
    }))
  }
  function removeApproach(id: string) {
    setDraft((d) => ({
      ...d,
      planned_approaches: d.planned_approaches.filter((a) => a._id !== id),
    }))
  }
  function setApproachField(id: string, field: 'title' | 'text', val: string) {
    setDraft((d) => ({
      ...d,
      planned_approaches: d.planned_approaches.map((a) =>
        a._id === id ? { ...a, [field]: val } : a
      ),
    }))
  }

  // ── Edit mode ────────────────────────────────────────────────────────────────

  if (isEditing) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <h1 className={styles.title}>Problématique & hypothèses</h1>
        </div>

        <div className={styles.form}>
          {/* Research problem */}
          <div className={styles.group}>
            <label className={styles.fieldLabel}>Problème de recherche</label>
            <AutoTextarea
              className={styles.textarea}
              value={draft.research_problem}
              onChange={(e) => set('research_problem', e.target.value)}
              placeholder="Quelle est la question ou le problème central de cette recherche ?"
              disabled={isSaving}
            />
            {draft.sub_research_problem === null ? (
              <button
                className={styles.btnAdd}
                onClick={() => set('sub_research_problem', '')}
                disabled={isSaving}
                type="button"
              >
                <Plus size={12} /> Ajouter une sous-problématique
              </button>
            ) : (
              <div className={styles.subGroup}>
                <div className={styles.subGroupHeader}>
                  <span className={styles.subFieldLabel}>Sous-problématique</span>
                  <button
                    className={styles.btnRemove}
                    onClick={() => set('sub_research_problem', null)}
                    disabled={isSaving}
                    type="button"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
                <AutoTextarea
                  className={styles.textarea}
                  value={draft.sub_research_problem}
                  onChange={(e) => set('sub_research_problem', e.target.value)}
                  placeholder="Précision ou déclinaison du problème principal…"
                  disabled={isSaving}
                />
              </div>
            )}
          </div>

          {/* Hypotheses */}
          <div className={styles.group}>
            <label className={styles.fieldLabel}>Hypothèses</label>
            {draft.hypotheses.map((h, i) => (
              <div key={h._id} className={styles.itemBlock}>
                <div className={styles.itemBlockHeader}>
                  <span className={styles.itemNumber}>Hypothèse {i + 1}</span>
                  <button
                    className={styles.btnRemove}
                    onClick={() => removeHypothesis(h._id)}
                    disabled={isSaving}
                    type="button"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
                <AutoTextarea
                  className={styles.textarea}
                  value={h.text}
                  onChange={(e) => setHypoText(h._id, e.target.value)}
                  placeholder="Formule ton hypothèse…"
                  disabled={isSaving}
                />
                <div className={styles.itemBlockHeader}>
                  <span className={styles.itemNumber}>
                    Sous-hypothèse{h.subs.length > 0 ? 's' : ''}{' '}
                    {h.subs.length > 0 && `(${h.subs.length})`}
                  </span>
                </div>
                {h.subs.length > 0 && (
                  <div className={styles.subList}>
                    {h.subs.map((s, j) => (
                      <div key={s._id} className={styles.subItem}>
                        <span className={styles.subItemBullet}>{j + 1}.</span>
                        <AutoTextarea
                          className={`${styles.textarea} ${styles.textareaSub}`}
                          value={s.text}
                          onChange={(e) => setSubHypText(h._id, s._id, e.target.value)}
                          placeholder="Sous-hypothèse…"
                          disabled={isSaving}
                        />
                        <button
                          className={styles.btnRemove}
                          onClick={() => removeSubHyp(h._id, s._id)}
                          disabled={isSaving}
                          type="button"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  className={styles.btnAddSm}
                  onClick={() => addSubHyp(h._id)}
                  disabled={isSaving}
                  type="button"
                >
                  <Plus size={11} /> Sous-hypothèse
                </button>
              </div>
            ))}
            <button
              className={styles.btnAdd}
              onClick={addHypothesis}
              disabled={isSaving}
              type="button"
            >
              <Plus size={12} /> Ajouter une hypothèse
            </button>
          </div>

          {/* Approaches */}
          <div className={styles.group}>
            <label className={styles.fieldLabel}>Approches planifiées</label>
            {draft.planned_approaches.map((a, i) => (
              <div key={a._id} className={styles.itemBlock}>
                <div className={styles.itemBlockHeader}>
                  <span className={styles.itemNumber}>Approche {i + 1}</span>
                  <button
                    className={styles.btnRemove}
                    onClick={() => removeApproach(a._id)}
                    disabled={isSaving}
                    type="button"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
                <input
                  className={styles.inputTitle}
                  type="text"
                  value={a.title}
                  onChange={(e) => setApproachField(a._id, 'title', e.target.value)}
                  placeholder="Titre (optionnel)"
                  disabled={isSaving}
                />
                <AutoTextarea
                  className={styles.textarea}
                  value={a.text}
                  onChange={(e) => setApproachField(a._id, 'text', e.target.value)}
                  placeholder="Décris cette approche ou méthodologie…"
                  disabled={isSaving}
                />
              </div>
            ))}
            <button
              className={styles.btnAdd}
              onClick={addApproach}
              disabled={isSaving}
              type="button"
            >
              <Plus size={12} /> Ajouter une approche
            </button>
          </div>

          {/* Expected outcomes */}
          <div className={styles.group}>
            <label className={styles.fieldLabel}>Résultats attendus</label>
            <AutoTextarea
              className={styles.textarea}
              value={draft.expected_outcomes}
              onChange={(e) => set('expected_outcomes', e.target.value)}
              placeholder="Quels sont les apports ou contributions espérés ?"
              disabled={isSaving}
            />
          </div>

          {saveError && <p className={styles.saveError}>{saveError}</p>}

          <div className={styles.actions}>
            <button className={styles.btnSecondary} onClick={handleCancel} disabled={isSaving}>
              Annuler
            </button>
            <button className={styles.btnPrimary} onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Read mode ────────────────────────────────────────────────────────────────

  const isEmpty =
    data &&
    !data.research_problem &&
    !data.sub_research_problem &&
    data.hypotheses.length === 0 &&
    data.planned_approaches.length === 0 &&
    !data.expected_outcomes

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>Problématique & hypothèses</h1>
        <button className={styles.btnSecondary} onClick={handleEdit}>
          <Pencil size={14} />
          Modifier
        </button>
      </div>

      {data === null ? (
        <div className={styles.loading} />
      ) : isEmpty ? (
        <p className={styles.emptyHint}>
          Aucune problématique définie.{' '}
          <button className={styles.inlineLink} onClick={handleEdit}>
            Commencer maintenant
          </button>
        </p>
      ) : (
        <div className={styles.sections}>
          {(data.research_problem || data.sub_research_problem) && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Problème de recherche</p>
              {data.research_problem ? (
                <p className={styles.sectionText}>{data.research_problem}</p>
              ) : (
                <p className={styles.sectionMuted}>Non défini</p>
              )}
              {data.sub_research_problem && (
                <div className={styles.subSection}>
                  <p className={styles.subSectionLabel}>Sous-problématique</p>
                  <p className={styles.sectionText}>{data.sub_research_problem}</p>
                </div>
              )}
            </div>
          )}

          {data.hypotheses.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Hypothèses</p>
              <ol className={styles.readList}>
                {data.hypotheses.map((h, i) => (
                  <li key={i} className={styles.readListItem}>
                    {h.text ? (
                      <p className={styles.sectionText}>{h.text}</p>
                    ) : (
                      <p className={styles.sectionMuted}>Non définie</p>
                    )}
                    {h.sub_hypotheses.length > 0 && (
                      <ul className={styles.readSubList}>
                        {h.sub_hypotheses.map((s, j) => (
                          <li key={j} className={styles.readSubListItem}>
                            <p className={styles.sectionText}>{s}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {data.planned_approaches.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Approches planifiées</p>
              <div className={styles.readApproaches}>
                {data.planned_approaches.map((a, i) => (
                  <div key={i} className={styles.readApproach}>
                    <p className={styles.readApproachTitle}>
                      Approche {i + 1}
                      {a.title ? ` — ${a.title}` : ''}
                    </p>
                    {a.text ? (
                      <p className={styles.sectionText}>{a.text}</p>
                    ) : (
                      <p className={styles.sectionMuted}>Non définie</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.expected_outcomes && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Résultats attendus</p>
              <p className={styles.sectionText}>{data.expected_outcomes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
