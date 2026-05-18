import type { GraphNodeType } from '../../api/graph'
import styles from './GraphView.module.scss'

/** How node fill colour is derived: by node type (the default — papers,
 * authors, categories, concepts each get their own colour) or by Louvain
 * community (each detected cluster gets a distinct hue). */
export type ColorMode = 'type' | 'community'

export interface FilterState {
  paper: boolean
  author: boolean
  category: boolean
  concept: boolean
  semanticThreshold: number
  colorBy: ColorMode
}

export const DEFAULT_FILTERS: FilterState = {
  paper: true,
  author: true,
  category: true,
  concept: true,
  semanticThreshold: 0.6,
  colorBy: 'type',
}

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
