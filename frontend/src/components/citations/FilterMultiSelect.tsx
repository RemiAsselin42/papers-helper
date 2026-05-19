import { ChevronDown } from 'lucide-react'
import { useRef, useState } from 'react'
import { useDismiss } from '../../hooks/useDismiss'
import styles from './FilterMultiSelect.module.scss'

/** One selectable entry: `value` is filtered on, `label` is displayed. */
export interface FilterOption {
  value: string
  label: string
}

interface Props {
  /** Trigger text when nothing is selected (e.g. "Toutes les sources"). */
  emptyLabel: string
  options: FilterOption[]
  selected: string[]
  onChange: (next: string[]) => void
  /** Accessible name for the trigger button and the option list. */
  ariaLabel: string
}

/**
 * Compact multi-select filter: a trigger button that opens a checkbox list.
 * Replaces a native `<select multiple>` — the popover is real DOM, so option
 * labels can be width-capped and ellipsised (a native select popup can't).
 */
export function FilterMultiSelect({ emptyLabel, options, selected, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useDismiss(open, rootRef, () => setOpen(false))

  const toggle = (value: string) => {
    onChange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
    )
  }

  const selectedSet = new Set(selected)
  const count = selected.length

  // 0 → placeholder; 1 → the chosen label; N → a count (the chosen labels
  // wouldn't fit the compact trigger).
  let triggerLabel = emptyLabel
  if (count === 1) {
    triggerLabel = options.find((o) => o.value === selected[0])?.label ?? selected[0]
  } else if (count > 1) {
    triggerLabel = `${count} sélectionnés`
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${count > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        <ChevronDown
          size={14}
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className={styles.popover}>
          <ul className={styles.list} role="listbox" aria-multiselectable="true" aria-label={ariaLabel}>
            {options.length === 0 && <li className={styles.emptyHint}>Aucune option</li>}
            {options.map((o) => {
              const checked = selectedSet.has(o.value)
              return (
                <li key={o.value} role="option" aria-selected={checked}>
                  <label className={styles.option}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.value)}
                      aria-label={o.label}
                    />
                    <span className={styles.optionLabel} title={o.label}>
                      {o.label}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {count > 0 && (
            <button type="button" className={styles.clearBtn} onClick={() => onChange([])}>
              Effacer ({count})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
