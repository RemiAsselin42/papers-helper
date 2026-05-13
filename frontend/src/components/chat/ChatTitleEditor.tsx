import styles from './ChatView.module.scss'

interface Props {
  value: string
  currentTitle: string
  onChange: (next: string) => void
  onCommit: () => void
  disabled: boolean
}

export function ChatTitleEditor({ value, currentTitle, onChange, onCommit, disabled }: Props) {
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
      placeholder="Nouvelle conversation"
      disabled={disabled}
      title={value || 'Nouvelle conversation'}
      aria-label="Nom de la conversation"
    />
  )
}
