import { useState } from 'react'
import { createProject, type ProjectInfo } from '../api/projects'
import styles from './NewProjectView.module.scss'

interface NewProjectViewProps {
  onCreated: (project: ProjectInfo) => void
}

export function NewProjectView({ onCreated }: NewProjectViewProps) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      const project = await createProject(trimmed)
      onCreated(project)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>New project</h1>
      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          type="text"
          placeholder="Project name"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={80}
          autoFocus
          disabled={submitting}
        />
        <button
          type="submit"
          className={styles.btnPrimary}
          disabled={!name.trim() || submitting}
        >
          Create
        </button>
      </form>
    </div>
  )
}
