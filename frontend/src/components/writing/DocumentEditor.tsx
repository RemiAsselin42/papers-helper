import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import TextStyle from '@tiptap/extension-text-style'
import { Check, Loader2, X } from 'lucide-react'
import { PaginationPlus, PAGE_SIZES } from 'tiptap-pagination-plus'
import { FontSize } from './FontSize'
import { EditorToolbar } from './EditorToolbar'
import type { SaveState } from './WritingView'
import styles from './DocumentEditor.module.scss'

interface Props {
  /** Initial HTML — read once at mount; the editor is uncontrolled afterwards.
   *  WritingView remounts this component (via `key`) when the document changes. */
  initialHtml: string
  /** Title of the open document — used as the export file name. */
  docTitle: string
  /** Save status — surfaced as a floating badge while in focus mode. */
  saveState: SaveState
  /** Fires on every editor change with the serialised HTML. */
  onChange: (html: string) => void
  /** Receives the editor instance once ready (cursor inserts go through it). */
  onEditorReady: (editor: Editor) => void
}

/**
 * The single always-editable tiptap text zone of a writing document, with a
 * formatting toolbar (bold/italic/underline, alignment, font size). Generated
 * passages and citations are inserted through the editor instance handed back
 * by `onEditorReady`.
 */
export function DocumentEditor({
  initialHtml,
  docTitle,
  saveState,
  onChange,
  onEditorReady,
}: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onReadyRef = useRef(onEditorReady)
  onReadyRef.current = onEditorReady

  // Full-screen focus mode: the editor + toolbar cover the whole viewport.
  const [focusMode, setFocusMode] = useState(false)
  useEffect(() => {
    if (!focusMode) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setFocusMode(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [focusMode])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Commencez à rédiger…' }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      FontSize,
      // Word-like A4 pages: visual page breaks, gray gutter between sheets and
      // a page number in the bottom-right footer. Kept last so its decorations
      // layer over the other extensions.
      PaginationPlus.configure({
        ...PAGE_SIZES.A4,
        pageWidth: 798,
        marginTop: 95,
        marginBottom: 95,
        marginLeft: 90,
        marginRight: 90,
        pageGap: 24,
        pageGapBorderSize: 0,
        pageGapBorderColor: '#fff',
        pageBreakBackground: '#fefae0',
        contentMarginTop: 0,
        contentMarginBottom: 0,
        headerLeft: '',
        headerRight: '',
        footerLeft: '',
        // `{page}` is substituted by the extension; `/ N` (the total) is kept
        // in sync from the rendered DOM by the effect below.
        footerRight: '{page} / 1',
      }),
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => onChangeRef.current(editor.getHTML()),
    onCreate: ({ editor }) => onReadyRef.current(editor),
  })

  // PaginationPlus only knows the current page (`{page}`), not the total. Read
  // the rendered page count from the DOM and push it into the footer as
  // "{page} / N" whenever it changes.
  useEffect(() => {
    if (!editor) return
    let lastTotal = -1
    const sync = () => {
      if (editor.isDestroyed) return
      const pages = editor.view.dom.querySelector('[data-rm-pagination]')?.children.length ?? 1
      const total = Math.max(pages, 1)
      if (total === lastTotal) return
      lastTotal = total
      editor.commands.updateFooterContent('', `{page} / ${total}`)
    }
    const onTransaction = () => requestAnimationFrame(sync)
    editor.on('transaction', onTransaction)
    onTransaction()
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor])

  return (
    <div className={`${styles.root} ${focusMode ? styles.rootFocus : ''}`}>
      <EditorToolbar
        editor={editor}
        docTitle={docTitle}
        focusMode={focusMode}
        onToggleFocus={() => setFocusMode((v) => !v)}
      />
      <EditorContent editor={editor} className={styles.editor} />
      {focusMode && saveState !== 'idle' && (
        <div
          className={`${styles.focusSave} ${saveState === 'error' ? styles.focusSaveErr : ''}`}
          role="status"
        >
          {saveState === 'saving' && <Loader2 size={16} className={styles.spin} />}
          {saveState === 'saved' && <Check size={16} />}
          {saveState === 'error' && <X size={16} />}
        </div>
      )}
    </div>
  )
}
