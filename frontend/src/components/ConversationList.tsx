import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PROVIDER_LABELS } from '../api/llm'
import type { ConversationSummary } from '../api/conversations'
import { Skeleton } from './Skeleton'
import styles from './ConversationList.module.scss'

interface Props {
  conversations: ConversationSummary[]
  loading?: boolean
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

export function ConversationList({
  conversations,
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

  function startEdit(c: ConversationSummary) {
    setEditingId(c.id)
    setDraft(c.title)
  }

  function commitEdit() {
    if (editingId) {
      const trimmed = draft.trim()
      const original = conversations.find((c) => c.id === editingId)
      if (trimmed && original && trimmed !== original.title) {
        onRename(editingId, trimmed)
      }
    }
    setEditingId(null)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  return (
    <aside className={styles.root} aria-label="Historique des conversations">
      <button type="button" className={styles.newBtn} onClick={onNew}>
        <MessageSquarePlus size={20} />
        <span>Nouvelle conversation</span>
      </button>

      <ul className={styles.list}>
        {loading && conversations.length > 0 ? (
          <li className={styles.skeletonList} aria-hidden>
            {Array.from({ length: conversations.length }).map((_, i) => (
              <div key={i} className={styles.skeletonItem}>
                <Skeleton height={14} />
                <Skeleton width="50%" height={12} />
              </div>
            ))}
          </li>
        ) : !loading && conversations.length === 0 ? (
          <li className={styles.empty}>Aucune conversation enregistrée.</li>
        ) : null}
        {!loading &&
          conversations.map((c) => {
            const active = c.id === currentId
            const isEditing = c.id === editingId
            return (
              <li key={c.id} className={`${styles.item} ${active ? styles.active : ''}`}>
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => !isEditing && onSelect(c.id)}
                  onDoubleClick={() => startEdit(c)}
                  title={c.title}
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
                          cancelEdit()
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className={styles.title}>{c.title}</span>
                  )}
                  <span className={styles.meta}>
                    {PROVIDER_LABELS[c.provider]} · {c.model}
                  </span>
                </button>
                {!isEditing && (
                  <button
                    type="button"
                    className={styles.renameBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      startEdit(c)
                    }}
                    aria-label="Renommer la conversation"
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
                    onDelete(c.id)
                  }}
                  aria-label="Supprimer la conversation"
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
