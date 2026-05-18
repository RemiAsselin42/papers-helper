import { useEffect, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Italic,
  Underline,
} from 'lucide-react'
import styles from './EditorToolbar.module.scss'

interface Props {
  editor: Editor | null
}

/** Base font size of the document (pt) — no textStyle mark means this size. */
const DEFAULT_FONT_SIZE = 12
const MIN_FONT_SIZE = 6
const MAX_FONT_SIZE = 96
const FONT_SIZE_SUGGESTIONS = [8, 10, 11, 12, 14, 16, 18, 20, 24]

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
export function EditorToolbar({ editor }: Props) {
  const fontSize = editor?.getAttributes('textStyle').fontSize as string | undefined
  const currentSize = fontSize ? parseInt(fontSize, 10) : DEFAULT_FONT_SIZE

  // Local draft so multi-digit typing isn't applied digit-by-digit; re-synced
  // whenever the selection lands on text with a different size.
  const [sizeDraft, setSizeDraft] = useState(String(currentSize))
  useEffect(() => {
    setSizeDraft(String(currentSize))
  }, [currentSize])

  if (!editor) return null

  function applySize(raw: string) {
    if (!editor) return
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return
    if (n === DEFAULT_FONT_SIZE) editor.chain().focus().unsetFontSize().run()
    else editor.chain().focus().setFontSize(`${n}pt`).run()
  }

  function onSizeChange(value: string) {
    setSizeDraft(value)
    // A datalist pick yields an exact suggestion — apply it at once.
    if (FONT_SIZE_SUGGESTIONS.includes(Number(value))) applySize(value)
  }

  function stepSize(delta: number) {
    const base = parseInt(sizeDraft, 10)
    applySize(String((Number.isNaN(base) ? DEFAULT_FONT_SIZE : base) + delta))
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

      {/* type="text" (not "number"): browsers reliably open the datalist
          suggestions on click only for text inputs. inputMode keeps the
          numeric keypad on mobile; a custom ▲/▼ column replaces the native
          number spinners. The value is still validated as a number. */}
      <div className={styles.sizeField}>
        <input
          type="text"
          inputMode="numeric"
          list="writing-font-sizes"
          className={styles.sizeInput}
          value={sizeDraft}
          onChange={(e) => onSizeChange(e.target.value)}
          onBlur={(e) => applySize(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
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
      </div>
      <datalist id="writing-font-sizes">
        {FONT_SIZE_SUGGESTIONS.map((size) => (
          <option key={size} value={size} />
        ))}
      </datalist>
    </div>
  )
}
