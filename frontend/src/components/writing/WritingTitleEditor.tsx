import styles from './WritingView.module.scss'

interface Props {
  value: string
  currentTitle: string
  onChange: (next: string) => void
  onCommit: () => void
  disabled: boolean
}

/** Inline editable document title in the toolbar — same UX as the chat title. */
export function WritingTitleEditor({ value, currentTitle, onChange, onCommit, disabled }: Props) {
  return (
    <input
      type="text"
      className={styles.toolbarTitle}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onChange(currentTitle)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      placeholder="Nouveau texte"
      disabled={disabled}
      title={value || 'Nouveau texte'}
      aria-label="Nom du texte"
    />
  )
}
