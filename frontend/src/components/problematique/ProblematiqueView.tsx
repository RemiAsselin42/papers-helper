import { useEffect, useState } from 'react'
import { getProblematique, saveProblematique, type Problematique } from '../../api/problematique'
import { ProblematiqueEdit } from './ProblematiqueEdit'
import { ProblematiqueRead } from './ProblematiqueRead'
import { draftToApi, EMPTY, initDraft, type Draft } from './problematique.draft'

interface Props {
  projectId: string
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

  if (isEditing) {
    return (
      <ProblematiqueEdit
        draft={draft}
        setDraft={setDraft}
        isSaving={isSaving}
        saveError={saveError}
        onCancel={handleCancel}
        onSave={handleSave}
      />
    )
  }
  return <ProblematiqueRead data={data} onEdit={handleEdit} />
}
