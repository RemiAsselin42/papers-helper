import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { updateSourceMetadata, type SourceInfo, type UpdateMetadataPayload } from '../api/projects'
import { extractBibtexCategories } from '../utils'
import styles from './MetadataModal.module.scss'

interface AuthorEntry {
  first_name: string
  last_name: string
}

interface MetadataDraft {
  pdf_title: string
  authors: AuthorEntry[]
  year: string
  publication: string
  doi: string
  abstract: string
  notes: string
}

interface MetadataModalProps {
  projectId: string
  source: SourceInfo
  onSave: (updated: SourceInfo) => void
  onClose: () => void
}

function parseAuthors(source: SourceInfo): AuthorEntry[] {
  if (source.authors_json) {
    try {
      const parsed = JSON.parse(source.authors_json)
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Handle both CSL format {family, given} and internal {last_name, first_name}
        return (parsed as Record<string, string>[]).map((a) => ({
          first_name: a.first_name ?? a.given ?? '',
          last_name: a.last_name ?? a.family ?? '',
        }))
      }
    } catch {
      // fall through
    }
  }
  if (source.author) {
    return source.author.split(/\s*;\s*/).map((part) => {
      const [last = '', first = ''] = part.split(/\s*,\s*/)
      return { last_name: last.trim(), first_name: first.trim() }
    })
  }
  return [{ first_name: '', last_name: '' }]
}

function authorsToFlat(authors: AuthorEntry[]): string {
  return authors
    .filter((a) => a.first_name || a.last_name)
    .map((a) =>
      a.last_name && a.first_name ? `${a.last_name}, ${a.first_name}` : a.last_name || a.first_name
    )
    .join(' ; ')
}

export function MetadataModal({ projectId, source, onSave, onClose }: MetadataModalProps) {
  const [draft, setDraft] = useState<MetadataDraft>(() => ({
    pdf_title: source.pdf_title,
    authors: parseAuthors(source),
    year: source.year,
    publication: source.publication,
    doi: source.doi,
    abstract: source.abstract,
    notes: source.notes,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstInputRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function setField<K extends keyof MetadataDraft>(key: K, value: MetadataDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function setAuthor(index: number, field: keyof AuthorEntry, value: string) {
    setDraft((d) => {
      const authors = d.authors.map((a, i) => (i === index ? { ...a, [field]: value } : a))
      return { ...d, authors }
    })
  }

  function addAuthor() {
    setDraft((d) => ({ ...d, authors: [...d.authors, { first_name: '', last_name: '' }] }))
  }

  function removeAuthor(index: number) {
    setDraft((d) => {
      const authors = d.authors.filter((_, i) => i !== index)
      return { ...d, authors: authors.length > 0 ? authors : [{ first_name: '', last_name: '' }] }
    })
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    const authors = draft.authors.filter((a) => a.first_name || a.last_name)
    const payload: UpdateMetadataPayload = {
      pdf_title: draft.pdf_title,
      author: authorsToFlat(authors),
      authors_json: JSON.stringify(authors),
      year: draft.year,
      publication: draft.publication,
      doi: draft.doi,
      abstract: draft.abstract,
      notes: draft.notes,
    }
    try {
      const updated = await updateSourceMetadata(projectId, source.stem, payload)
      onSave(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      setSaving(false)
    }
  }

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.dialog} role="dialog" aria-modal aria-label="Modifier les métadonnées">
        <div className={styles.header}>
          <span className={styles.headerTitle}>Modifier les métadonnées</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.field}>
            <label className={styles.label}>Titre</label>
            <input
              ref={firstInputRef}
              className={styles.input}
              value={draft.pdf_title}
              onChange={(e) => setField('pdf_title', e.target.value)}
              placeholder="Titre de la source"
              disabled={saving}
            />
          </div>

          {extractBibtexCategories(source.pdf_title).length > 0 && (
            <div className={styles.field}>
              <label className={styles.label}>Catégories</label>
              <div className={styles.categories}>
                {extractBibtexCategories(source.pdf_title).map((cat) => (
                  <span key={cat} className={styles.categoryTag}>
                    {cat}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>Auteurs</label>
            <div className={styles.authorsList}>
              {draft.authors.map((author, i) => (
                <div key={i} className={styles.authorRow}>
                  <input
                    className={styles.input}
                    value={author.last_name}
                    onChange={(e) => setAuthor(i, 'last_name', e.target.value)}
                    placeholder="Nom"
                    disabled={saving}
                  />
                  <input
                    className={styles.input}
                    value={author.first_name}
                    onChange={(e) => setAuthor(i, 'first_name', e.target.value)}
                    placeholder="Prénom"
                    disabled={saving}
                  />
                  <button
                    className={styles.removeAuthorBtn}
                    onClick={() => removeAuthor(i)}
                    disabled={saving}
                    aria-label="Supprimer cet auteur"
                    title="Supprimer"
                    tabIndex={-1}
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              ))}
              <button className={styles.addAuthorBtn} onClick={addAuthor} disabled={saving}>
                <Plus size={16} /> Ajouter un auteur
              </button>
            </div>
          </div>

          <div className={styles.row}>
            <div className={styles.field}>
              <label className={styles.label}>Année</label>
              <input
                className={styles.input}
                value={draft.year}
                onChange={(e) => setField('year', e.target.value)}
                placeholder="2024"
                disabled={saving}
              />
            </div>
            <div className={`${styles.field} ${styles.fieldGrow}`}>
              <label className={styles.label}>Publication / Éditeur</label>
              <input
                className={styles.input}
                value={draft.publication}
                onChange={(e) => setField('publication', e.target.value)}
                placeholder="Revue, éditeur ou site"
                disabled={saving}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>DOI</label>
            <input
              className={styles.input}
              value={draft.doi}
              onChange={(e) => setField('doi', e.target.value)}
              placeholder="10.xxxx/xxxxx"
              disabled={saving}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Résumé</label>
            <textarea
              className={styles.textarea}
              value={draft.abstract}
              onChange={(e) => setField('abstract', e.target.value)}
              placeholder="Résumé ou description de la source"
              disabled={saving}
              rows={4}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Notes</label>
            <textarea
              className={styles.textarea}
              value={draft.notes}
              onChange={(e) => setField('notes', e.target.value)}
              placeholder="Notes personnelles"
              disabled={saving}
              rows={3}
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={saving}>
            Annuler
          </button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  )
}
