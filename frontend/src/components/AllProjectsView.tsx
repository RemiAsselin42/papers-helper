import { useState } from 'react'
import { Check, Trash2, X } from 'lucide-react'
import { deleteProject, type ProjectInfo } from '../api/projects'
import styles from './AllProjectsView.module.scss'

interface AllProjectsViewProps {
  projects: ProjectInfo[]
  currentProjectId: string | null
  onProjectDeleted: (id: string) => void
}

export function AllProjectsView({
  projects,
  currentProjectId,
  onProjectDeleted,
}: AllProjectsViewProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

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

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
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
                <span className={styles.name}>{p.name}</span>
                {p.id === currentProjectId}
                <span className={styles.date}>{formatDate(p.created_at)}</span>
              </div>

              <div className={styles.actions}>
                {confirmId === p.id ? (
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
                ) : (
                  <button
                    className={`${styles.iconBtn} ${styles.deleteBtn}`}
                    onClick={() => setConfirmId(p.id)}
                    aria-label={`Delete ${p.name}`}
                    title="Delete project"
                  >
                    <Trash2 size={20} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
