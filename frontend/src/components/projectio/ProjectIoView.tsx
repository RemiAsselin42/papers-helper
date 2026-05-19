import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Download, FileArchive, Loader2, Upload, X } from 'lucide-react'
import { type ProjectInfo } from '../../api/projects'
import { exportProject, importProject, type ImportMode } from '../../api/projectIo'
import styles from './ProjectIoView.module.scss'

interface Props {
  projectId: string
  projectName: string
  /** `mode` distingue un remplacement (projet existant écrasé) d'un nouveau
   * projet (import simple ou duplicata) — l'app rafraîchit sa liste en
   * conséquence. */
  onImported: (project: ProjectInfo, mode: 'new' | 'replace') => void
}

export function ProjectIoView({ projectId, onImported }: Props) {
  const [includeVectors, setIncludeVectors] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ id: string; name: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Escape ferme la popup de conflit.
  useEffect(() => {
    if (!conflict) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setConflict(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [conflict])

  async function handleExport() {
    setExporting(true)
    setExportError(null)
    try {
      await exportProject(projectId, includeVectors)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Erreur lors de l'export")
    } finally {
      setExporting(false)
    }
  }

  function pickFile(next: File | null) {
    setFile(next)
    setConflict(null)
    setImportError(null)
  }

  async function runImport(mode: ImportMode) {
    if (!file) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await importProject(file, mode)
      if (result.kind === 'conflict') {
        setConflict({ id: result.id, name: result.name })
        return
      }
      setConflict(null)
      setFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      onImported(result.project, mode === 'replace' ? 'replace' : 'new')
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Erreur lors de l'import")
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <ArrowLeftRight className={styles.titleIcon} size={26} />
        <h1 className={styles.title}>Import / Export</h1>
      </div>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Exporter ce projet</h2>

        <label className={styles.toggleRow}>
          <span className={styles.switch}>
            <input
              type="checkbox"
              aria-label="Inclure les embeddings"
              className={styles.switchInput}
              checked={includeVectors}
              onChange={(e) => setIncludeVectors(e.target.checked)}
            />
            <span className={styles.switchTrack} aria-hidden="true" />
          </span>
          <span className={styles.label}>Inclure les embeddings (recommandé)</span>
        </label>
        <p className={styles.hint}>
          {includeVectors
            ? 'L’archive contient le vector store ChromaDB : import instantané, sans réindexation.'
            : 'Archive légère sans le vector store : une réindexation sera nécessaire après l’import.'}
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? <Loader2 size={16} className={styles.spin} /> : <Upload size={16} />}
            Exporter
          </button>
        </div>
        {exportError && <p className={styles.error}>{exportError}</p>}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Importer un projet</h2>
        <p className={styles.muted}>Sélectionne une archive .zip exportée depuis Papers Helper.</p>

        <button
          type="button"
          className={styles.dropZone}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileArchive size={20} />
          <span>{file ? file.name : 'Choisir un fichier .zip'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          aria-label="Archive de projet à importer"
          className={styles.hiddenInput}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnPrimary}
            onClick={() => runImport('auto')}
            disabled={!file || importing}
          >
            {importing ? <Loader2 size={16} className={styles.spin} /> : <Download size={16} />}
            Importer
          </button>
        </div>
        {importError && <p className={styles.error}>{importError}</p>}
      </section>

      {conflict && (
        <div
          className={styles.overlay}
          role="presentation"
          onMouseDown={(e) => e.target === e.currentTarget && setConflict(null)}
        >
          <div className={styles.dialog} role="dialog" aria-modal aria-label="Conflit d’import">
            <div className={styles.dialogHeader}>
              <span className={styles.dialogTitle}>Projet déjà présent</span>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => setConflict(null)}
                aria-label="Fermer"
              >
                <X size={20} />
              </button>
            </div>
            <div className={styles.dialogBody}>
              <p>
                Un projet nommé <strong>{conflict.name}</strong> existe déjà. Que faire ?
              </p>
              <div className={styles.conflictActions}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => runImport('duplicate')}
                  disabled={importing}
                >
                  Dupliquer
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={() => runImport('replace')}
                  disabled={importing}
                >
                  {importing && <Loader2 size={16} className={styles.spin} />}
                  Remplacer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
