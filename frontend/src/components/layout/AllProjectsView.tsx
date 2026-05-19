import { useState } from 'react'
import { ArrowRight, Check, Pencil, Trash2, X } from 'lucide-react'
import { deleteProject, updateProject, type ProjectInfo } from '../../api/projects'
import styles from './AllProjectsView.module.scss'

interface AllProjectsViewProps {
  projects: ProjectInfo[]
  currentProjectId: string | null
  onProjectDeleted: (id: string) => void
  onProjectRenamed: (project: ProjectInfo) => void
  onProjectSelect: (id: string) => void
}

export function AllProjectsView({
  projects,
  currentProjectId,
  onProjectDeleted,
  onProjectRenamed,
  onProjectSelect,
}: AllProjectsViewProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      await deleteProject(id)
      onProjectDeleted(id)
    } catch {
      // ignore
    } finally {
      setDeletingId(null)
      setConfirmId(null)
    }
  }

  function startEdit(p: ProjectInfo) {
    setConfirmId(null)
    setEditingId(p.id)
    setEditName(p.name)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditName('')
  }

  async function handleRename(id: string) {
    const name = editName.trim()
    if (!name) return
    setSavingId(id)
    try {
      const updated = await updateProject(id, name)
      onProjectRenamed(updated)
      cancelEdit()
    } catch {
      // ignore
    } finally {
      setSavingId(null)
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  function renderActions(p: ProjectInfo) {
    if (editingId === p.id) {
      return (
        <>
          <button
            className={`${styles.iconBtn} ${styles.cancelBtn}`}
            onClick={() => handleRename(p.id)}
            disabled={savingId === p.id || !editName.trim()}
            aria-label="Confirm rename"
            title="Confirm"
          >
            <Check size={20} />
          </button>
          <button
            className={styles.iconBtn}
            onClick={cancelEdit}
            disabled={savingId === p.id}
            aria-label="Cancel rename"
            title="Cancel"
          >
            <X size={20} />
          </button>
        </>
      )
    }

    if (confirmId === p.id) {
      return (
        <>
          <button
            className={`${styles.iconBtn} ${styles.deleteBtn}`}
            onClick={() => handleDelete(p.id)}
            disabled={deletingId === p.id}
            aria-label="Confirm delete"
            title="Confirm"
          >
            <Check size={20} />
          </button>
          <button
            className={`${styles.iconBtn} ${styles.cancelBtn}`}
            onClick={() => setConfirmId(null)}
            aria-label="Cancel"
            title="Cancel"
          >
            <X size={20} />
          </button>
        </>
      )
    }

    return (
      <>
        <button
          className={styles.iconBtn}
          onClick={() => onProjectSelect(p.id)}
          disabled={p.id === currentProjectId}
          aria-label={`Open ${p.name}`}
          title={p.id === currentProjectId ? 'Current project' : 'Open project'}
        >
          <ArrowRight size={20} />
        </button>
        <button
          className={styles.iconBtn}
          onClick={() => startEdit(p)}
          aria-label={`Rename ${p.name}`}
          title="Rename project"
        >
          <Pencil size={20} />
        </button>
        <button
          className={`${styles.iconBtn} ${styles.deleteBtn}`}
          onClick={() => setConfirmId(p.id)}
          aria-label={`Delete ${p.name}`}
          title="Delete project"
        >
          <Trash2 size={20} />
        </button>
      </>
    )
  }

  return (
    <div className={styles.root}>
      <h1 className={styles.heading}>All projects</h1>

      {projects.length === 0 ? (
        <p className={styles.empty}>No projects yet.</p>
      ) : (
        <ul className={styles.list}>
          {projects.map((p) => (
            <li
              key={p.id}
              className={`${styles.card} ${p.id === currentProjectId ? styles.cardCurrent : ''}`}
            >
              <div className={styles.cardBody}>
                {editingId === p.id ? (
                  <input
                    className={styles.nameInput}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(p.id)
                      if (e.key === 'Escape') cancelEdit()
                    }}
                    maxLength={80}
                    disabled={savingId === p.id}
                    aria-label="Project name"
                    autoFocus
                  />
                ) : (
                  <>
                    <span className={styles.name}>{p.name}</span>
                    <span className={styles.date}>{formatDate(p.created_at)}</span>
                  </>
                )}
              </div>

              <div className={styles.actions}>{renderActions(p)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
