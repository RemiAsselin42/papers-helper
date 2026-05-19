import type { GraphNodeType } from '../../api/graph'
import type { ColorMode, FilterState } from './filterState'
import styles from './GraphView.module.scss'

// Type-only re-exports are erased at build time, so they keep existing
// `from './GraphFilters'` type imports working without breaking Fast Refresh.
export type { ColorMode, FilterState } from './filterState'

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  type: 'Par type',
  community: 'Par communauté',
}

interface Props {
  filters: FilterState
  onChange: (next: FilterState) => void
  counts: Partial<Record<GraphNodeType, number>>
}

const SWATCHES: Record<GraphNodeType, string> = {
  paper: styles.swatchPaper,
  author: styles.swatchAuthor,
  category: styles.swatchCategory,
  concept: styles.swatchConcept,
}

const LABELS: Record<GraphNodeType, string> = {
  paper: 'Papers',
  author: 'Auteurs',
  category: 'Catégories',
  concept: 'Concepts',
}

export function GraphFilters({ filters, onChange, counts }: Props) {
  const setType = (type: GraphNodeType, enabled: boolean) =>
    onChange({ ...filters, [type]: enabled })

  return (
    <div className={styles.filters}>
      <div className={styles.filtersTitle}>Filtres</div>
      <div className={styles.toggleRow}>
        {(['paper', 'author', 'category', 'concept'] as GraphNodeType[]).map((type) => (
          <label key={type} className={styles.toggle}>
            <input
              type="checkbox"
              aria-label={LABELS[type]}
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
      <div className={styles.toggleRow}>
        <div className={styles.filtersTitle}>Couleur</div>
        {(['type', 'community'] as ColorMode[]).map((mode) => (
          <label key={mode} className={styles.toggle}>
            <input
              type="radio"
              name="graph-color-by"
              aria-label={COLOR_MODE_LABELS[mode]}
              checked={filters.colorBy === mode}
              onChange={() => onChange({ ...filters, colorBy: mode })}
            />
            <span>{COLOR_MODE_LABELS[mode]}</span>
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
          aria-label="Seuil de similarité sémantique"
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
