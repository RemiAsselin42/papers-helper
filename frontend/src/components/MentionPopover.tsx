import { useEffect, useMemo, useRef } from 'react'
import type { SourceInfo } from '../api/projects'
import { mentionSuggestions } from '../utils/mentions'
import { typeBadgeClass } from '../utils/typeBadgeClass'
import styles from './MentionPopover.module.scss'

interface Props {
  /** Text typed since the `@`, excluding the `@` itself. */
  query: string
  /** All sources for the current project. */
  sources: SourceInfo[]
  /** Index of the highlighted suggestion. */
  highlight: number
  /** Notify parent that the highlight should change (clamp/wrap handled here). */
  onHighlightChange: (idx: number) => void
  /** Called with the text to insert (`Pdf/` or `Pdf/foo.pdf`). */
  onSelect: (insertion: string) => void
}

export function MentionPopover({ query, sources, highlight, onHighlightChange, onSelect }: Props) {
  const items = useMemo(() => mentionSuggestions(query, sources), [query, sources])

  // Clamp highlight whenever the list shrinks.
  useEffect(() => {
    if (items.length === 0) return
    if (highlight < 0 || highlight >= items.length) {
      onHighlightChange(0)
    }
  }, [items.length, highlight, onHighlightChange])

  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  return (
    <div className={styles.root} role="listbox" aria-label="Mentionner une source">
      {items.length === 0 ? (
        <div className={styles.empty}>Aucune source — la mention sera ignorée à l’envoi.</div>
      ) : (
        <ul className={styles.list} ref={listRef}>
          {items.map((item, i) => {
            const pillText = item.badge ?? item.label
            const colorCls = typeBadgeClass(pillText, styles) ?? ''
            return (
              <li
                key={item.insertion}
                role="option"
                aria-selected={i === highlight}
                className={`${styles.item} ${i === highlight ? styles.itemActive : ''}`}
                onMouseEnter={() => onHighlightChange(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onSelect(item.insertion)
                }}
              >
                <span className={`${styles.itemType} ${colorCls}`}>{pillText}</span>
                {item.badge && <span className={styles.itemLabel}>{item.label}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
