import { Plus, Trash2 } from 'lucide-react'
import styles from './ProblematiqueView.module.scss'
import { AutoTextarea } from './AutoTextarea'
import { type Draft, uid } from './problematique.draft'

interface Props {
  draft: Draft
  setDraft: (updater: (prev: Draft) => Draft) => void
  isSaving: boolean
  saveError: string | null
  onCancel: () => void
  onSave: () => void
}

export function ProblematiqueEdit({
  draft,
  setDraft,
  isSaving,
  saveError,
  onCancel,
  onSave,
}: Props) {
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

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>Problématique & hypothèses</h1>
      </div>

      <div className={styles.form}>
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
              <Plus size={16} /> Ajouter une sous-problématique
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
                <Plus size={16} /> Sous-hypothèse
              </button>
            </div>
          ))}
          <button
            className={styles.btnAdd}
            onClick={addHypothesis}
            disabled={isSaving}
            type="button"
          >
            <Plus size={16} /> Ajouter une hypothèse
          </button>
        </div>

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
            <Plus size={16} /> Ajouter une approche
          </button>
        </div>

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
          <button className={styles.btnSecondary} onClick={onCancel} disabled={isSaving}>
            Annuler
          </button>
          <button className={styles.btnPrimary} onClick={onSave} disabled={isSaving}>
            {isSaving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}
