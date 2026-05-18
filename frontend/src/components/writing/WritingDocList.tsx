import { FilePlus, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WritingDocSummary } from '../../api/writing'
import { Skeleton } from '../layout/Skeleton'
import styles from './WritingDocList.module.scss'

interface Props {
  docs: WritingDocSummary[]
  loading?: boolean
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function WritingDocList({
  docs,
  loading = false,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  function startEdit(d: WritingDocSummary) {
    setEditingId(d.id)
    setDraft(d.title)
  }

  function commitEdit() {
    if (editingId) {
      const trimmed = draft.trim()
      const original = docs.find((d) => d.id === editingId)
      if (trimmed && original && trimmed !== original.title) {
        onRename(editingId, trimmed)
      }
    }
    setEditingId(null)
  }

  return (
    <aside className={styles.root} aria-label="Liste des textes">
      <button type="button" className={styles.newBtn} onClick={onNew}>
        <FilePlus size={20} />
        <span>Nouveau texte</span>
      </button>

      <ul className={styles.list}>
        {loading && docs.length > 0 ? (
          <li className={styles.skeletonList} aria-hidden>
            {Array.from({ length: docs.length }).map((_, i) => (
              <div key={i} className={styles.skeletonItem}>
                <Skeleton height={14} />
                <Skeleton width="50%" height={12} />
              </div>
            ))}
          </li>
        ) : !loading && docs.length === 0 ? (
          <li className={styles.empty}>Aucun texte enregistré.</li>
        ) : null}
        {!loading &&
          docs.map((d) => {
            const active = d.id === currentId
            const isEditing = d.id === editingId
            return (
              <li key={d.id} className={`${styles.item} ${active ? styles.active : ''}`}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => !isEditing && onSelect(d.id)}
                  onDoubleClick={() => startEdit(d)}
                  title={d.title}
                >
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      className={styles.titleInput}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setEditingId(null)
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className={styles.title}>{d.title}</span>
                  )}
                  <span className={styles.meta}>{formatDate(d.updated_at)}</span>
                </button>
                {!isEditing && (
                  <button
                    type="button"
                    className={styles.renameBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      startEdit(d)
                    }}
                    aria-label="Renommer le texte"
                    title="Renommer"
                  >
                    <Pencil size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.deleteBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(d.id)
                  }}
                  aria-label="Supprimer le texte"
                  title="Supprimer"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            )
          })}
      </ul>
    </aside>
  )
}
