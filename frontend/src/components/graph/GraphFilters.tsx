import type { GraphNodeType } from '../../api/graph'
import styles from './GraphView.module.scss'

export interface FilterState {
  paper: boolean
  author: boolean
  theme: boolean
  concept: boolean
  semanticThreshold: number
}

export const DEFAULT_FILTERS: FilterState = {
  paper: true,
  author: true,
  theme: true,
  concept: true,
  semanticThreshold: 0.6,
}

interface Props {
  filters: FilterState
  onChange: (next: FilterState) => void
  counts: Partial<Record<GraphNodeType, number>>
}

const SWATCHES: Record<GraphNodeType, string> = {
  paper: styles.swatchPaper,
  author: styles.swatchAuthor,
  theme: styles.swatchTheme,
  concept: styles.swatchConcept,
}

const LABELS: Record<GraphNodeType, string> = {
  paper: 'Papers',
  author: 'Auteurs',
  theme: 'Thèmes',
  concept: 'Concepts',
}

export function GraphFilters({ filters, onChange, counts }: Props) {
  const setType = (type: GraphNodeType, enabled: boolean) =>
    onChange({ ...filters, [type]: enabled })

  return (
    <div className={styles.filters}>
      <div className={styles.filtersTitle}>Filtres</div>
      <div className={styles.toggleRow}>
        {(['paper', 'author', 'theme', 'concept'] as GraphNodeType[]).map((type) => (
          <label key={type} className={styles.toggle}>
            <input
              type="checkbox"
              checked={filters[type]}
              onChange={(e) => setType(type, e.target.checked)}
            />
            <span className={`${styles.swatch} ${SWATCHES[type]}`} />
            <span>
              {LABELS[type]}
              {counts[type] != null && ` (${counts[type]})`}
            </span>
          </label>
        ))}
      </div>
      <div className={styles.slider}>
        <label htmlFor="semantic-threshold">
          Seuil similarité sémantique : {filters.semanticThreshold.toFixed(2)}
        </label>
        <input
          id="semantic-threshold"
          type="range"
          min={0.5}
          max={1}
          step={0.01}
          value={filters.semanticThreshold}
          onChange={(e) =>
            onChange({ ...filters, semanticThreshold: parseFloat(e.target.value) })
          }
        />
      </div>
    </div>
  )
}
