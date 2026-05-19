import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Download,
  Italic,
  Maximize2,
  Minimize2,
  Underline,
} from 'lucide-react'
import { DownloadModal } from './DownloadModal'
import { exportDocument, type ExportFormat } from './documentExport'
import styles from './EditorToolbar.module.scss'

interface Props {
  editor: Editor | null
  /** Title of the open document — used as the export file name. */
  docTitle: string
  /** Whether the editor is currently in full-screen focus mode. */
  focusMode: boolean
  /** Toggles full-screen focus mode. */
  onToggleFocus: () => void
}

/** Base font size of the document (pt) — no textStyle mark means this size. */
const DEFAULT_FONT_SIZE = 12
const MIN_FONT_SIZE = 6
const MAX_FONT_SIZE = 96
const FONT_SIZE_SUGGESTIONS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]

interface ToolBtnProps {
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
}

function ToolBtn({ active, label, onClick, children }: ToolBtnProps) {
  return (
    <button
      type="button"
      className={`${styles.btn} ${active ? styles.btnActive : ''}`}
      // Prevent the mousedown from blurring the editor (which would collapse
      // the selection before the formatting command runs).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      {children}
    </button>
  )
}

/** Formatting toolbar for the document editor: bold/italic/underline, text
 *  alignment, and font size. */
export function EditorToolbar({ editor, docTitle, focusMode, onToggleFocus }: Props) {
  const fontSize = editor?.getAttributes('textStyle').fontSize as string | undefined
  const currentSize = fontSize ? parseInt(fontSize, 10) : DEFAULT_FONT_SIZE

  const [showDownload, setShowDownload] = useState(false)

  // Local draft so multi-digit typing isn't applied digit-by-digit; re-synced
  // whenever the selection lands on text with a different size.
  const [sizeDraft, setSizeDraft] = useState(String(currentSize))
  useEffect(() => {
    setSizeDraft(String(currentSize))
  }, [currentSize])

  // Hand-made suggestions dropdown — shows the full list regardless of the
  // value typed in the input (unlike a native <datalist>, which filters).
  const [menuOpen, setMenuOpen] = useState(false)
  const sizeFieldRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(e: MouseEvent) {
      if (!sizeFieldRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen])

  if (!editor) return null

  function applySize(raw: string) {
    if (!editor) return
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return
    if (n === DEFAULT_FONT_SIZE) editor.chain().focus().unsetFontSize().run()
    else editor.chain().focus().setFontSize(`${n}pt`).run()
  }

  function stepSize(delta: number) {
    const base = parseInt(sizeDraft, 10)
    applySize(String((Number.isNaN(base) ? DEFAULT_FONT_SIZE : base) + delta))
  }

  function pickSize(size: number) {
    setSizeDraft(String(size))
    applySize(String(size))
    setMenuOpen(false)
  }

  function handleDownload(formats: ExportFormat[]) {
    if (!editor) return
    const html = editor.getHTML()
    const text = editor.getText()
    formats.forEach((f) => exportDocument(f, docTitle, html, text))
    setShowDownload(false)
  }

  return (
    <div className={styles.toolbar}>
      <ToolBtn
        active={editor.isActive('bold')}
        label="Gras"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={16} />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('italic')}
        label="Italique"
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={16} />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive('underline')}
        label="Souligné"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline size={16} />
      </ToolBtn>

      <span className={styles.sep} aria-hidden="true" />

      <ToolBtn
        active={editor.isActive({ textAlign: 'left' })}
        label="Aligner à gauche"
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
      >
        <AlignLeft size={16} />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'center' })}
        label="Centrer"
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
      >
        <AlignCenter size={16} />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'right' })}
        label="Aligner à droite"
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
      >
        <AlignRight size={16} />
      </ToolBtn>
      <ToolBtn
        active={editor.isActive({ textAlign: 'justify' })}
        label="Justifier"
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
      >
        <AlignJustify size={16} />
      </ToolBtn>

      <span className={styles.sep} aria-hidden="true" />

      {/* type="text" with no native spinners and no <datalist>: a custom ▲/▼
          stepper column handles increments, and a hand-made dropdown lists the
          full set of suggestions regardless of the typed value. */}
      <div className={styles.sizeField} ref={sizeFieldRef}>
        <input
          type="text"
          className={styles.sizeInput}
          value={sizeDraft}
          onChange={(e) => setSizeDraft(e.target.value)}
          onFocus={() => setMenuOpen(true)}
          onClick={() => setMenuOpen(true)}
          onBlur={(e) => applySize(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'Escape') setMenuOpen(false)
          }}
          aria-label="Taille de police"
          title="Taille de police (pt)"
        />
        <div className={styles.sizeSteppers}>
          <button
            type="button"
            className={styles.sizeStep}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => stepSize(1)}
            aria-label="Augmenter la taille de police"
            tabIndex={-1}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            className={styles.sizeStep}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => stepSize(-1)}
            aria-label="Diminuer la taille de police"
            tabIndex={-1}
          >
            <ChevronDown size={12} />
          </button>
        </div>
        {menuOpen && (
          <ul className={styles.sizeMenu} role="listbox" aria-label="Tailles de police">
            {FONT_SIZE_SUGGESTIONS.map((size) => (
              <li key={size}>
                <button
                  type="button"
                  role="option"
                  aria-selected={size === currentSize}
                  className={`${styles.sizeOption} ${
                    size === currentSize ? styles.sizeOptionActive : ''
                  }`}
                  // Prevent the input from blurring before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSize(size)}
                >
                  {size}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.pushRight}>
        <ToolBtn active={false} label="Télécharger le texte" onClick={() => setShowDownload(true)}>
          <Download size={18} />
        </ToolBtn>
        <ToolBtn
          active={focusMode}
          label={focusMode ? 'Quitter le mode focus' : 'Mode focus (plein écran)'}
          onClick={onToggleFocus}
        >
          {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </ToolBtn>
      </div>

      {showDownload && (
        <DownloadModal onDownload={handleDownload} onClose={() => setShowDownload(false)} />
      )}
    </div>
  )
}
