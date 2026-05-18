import { useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import TextStyle from '@tiptap/extension-text-style'
import { FontSize } from './FontSize'
import { EditorToolbar } from './EditorToolbar'
import styles from './DocumentEditor.module.scss'

interface Props {
  /** Initial HTML — read once at mount; the editor is uncontrolled afterwards.
   *  WritingView remounts this component (via `key`) when the document changes. */
  initialHtml: string
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
export function DocumentEditor({ initialHtml, onChange, onEditorReady }: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onReadyRef = useRef(onEditorReady)
  onReadyRef.current = onEditorReady

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Commencez à rédiger…' }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      FontSize,
    ],
    content: initialHtml,
    onUpdate: ({ editor }) => onChangeRef.current(editor.getHTML()),
    onCreate: ({ editor }) => onReadyRef.current(editor),
  })

  return (
    <div className={styles.root}>
      <EditorToolbar editor={editor} />
      <EditorContent editor={editor} className={styles.editor} />
    </div>
  )
}
