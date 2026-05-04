import { useEffect } from 'react'
import { X } from 'lucide-react'
import styles from './HelpModal.module.scss'

interface HelpModalProps {
  onClose: () => void
}

export function HelpModal({ onClose }: HelpModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.dialog} role="dialog" aria-modal aria-label="Aide à l'importation">
        <div className={styles.header}>
          <span className={styles.headerTitle}>Formats et compatibilité</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Fermer">
            <X size={20} />
          </button>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Formats supportés</h3>
            <ul className={styles.list}>
              <li>
                <strong>Documents :</strong> <code>.pdf</code>, <code>.docx</code>,{' '}
                <code>.txt</code>, <code>.odt</code>, <code>.rtf</code>, <code>.html</code>,{' '}
                <code>.epub</code>
              </li>
              <li>
                <strong>Bibliographie :</strong> <code>.bib</code> (BibTeX / Better BibTeX)
              </li>
              <li>
                <strong>Archives :</strong> <code>.zip</code> (dossier exporté depuis Zotero)
              </li>
            </ul>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Import par URL</h3>
            <ul className={styles.list}>
              <li>Pages web accessibles publiquement (le contenu HTML est récupéré)</li>
              <li>
                PDF en ligne via un lien direct vers un fichier <code>.pdf</code>
              </li>
              <li>Les URLs derrière un pare-feu ou une authentification ne sont pas accessibles</li>
            </ul>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Astuce Zotero</h3>
            <p className={styles.text}>
              Exportez votre bibliothèque (ou une sélection) via <em>Better BibTeX</em> en cochant{' '}
              <strong>«&nbsp;Exporter les fichiers&nbsp;»</strong>. Vous obtenez un dossier
              contenant le <code>.bib</code> et les PDF associés. Deux options&nbsp;:
            </p>
            <ul className={styles.list}>
              <li>
                Zippez le dossier et déposez le <code>.zip</code> ici
              </li>
              <li>
                Ou sélectionnez le <code>.bib</code> et les PDF simultanément
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
