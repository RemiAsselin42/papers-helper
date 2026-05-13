import { RotateCcw, Search } from 'lucide-react'
import {
  DEFAULT_FILTERS,
  FORMAT_LABEL,
  isFilterActive,
  NO_YEAR_VALUE,
  type IndexedFilter,
  type SourceFilterState,
} from './SourceList.filters'
import styles from './SourceList.module.scss'

export interface SourceFiltersProps {
  state: SourceFilterState
  onChange: (next: SourceFilterState) => void
  availableTypes: string[]
  availableYears: string[]
  availableCategories: string[]
  total: number
  shown: number
}

export function SourceFilters({
  state,
  onChange,
  availableTypes,
  availableYears,
  availableCategories,
  total,
  shown,
}: SourceFiltersProps) {
  const active = isFilterActive(state)
  const set = <K extends keyof SourceFilterState>(key: K, value: SourceFilterState[K]) =>
    onChange({ ...state, [key]: value })

  return (
    <div className={styles.toolbar}>
      <div className={styles.searchRow}>
        <Search size={18} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Rechercher par titre ou auteur…"
          value={state.search}
          onChange={(e) => set('search', e.target.value)}
          aria-label="Rechercher dans les sources"
        />
      </div>

      <div className={styles.filterRow}>
        <select
          className={styles.filterSelect}
          value={state.type}
          onChange={(e) => set('type', e.target.value)}
          aria-label="Filtrer par type"
        >
          <option value="">Tous les types</option>
          {availableTypes.map((t) => (
            <option key={t} value={t}>
              {FORMAT_LABEL[t] ?? t.toUpperCase()}
            </option>
          ))}
        </select>

        <select
          className={styles.filterSelect}
          value={state.year}
          onChange={(e) => set('year', e.target.value)}
          aria-label="Filtrer par année"
        >
          <option value="">Toutes les années</option>
          {availableYears.map((y) =>
            y === NO_YEAR_VALUE ? (
              <option key={y} value={y}>
                Sans année
              </option>
            ) : (
              <option key={y} value={y}>
                {y}
              </option>
            )
          )}
        </select>

        {availableCategories.length > 0 && (
          <select
            className={styles.filterSelect}
            value={state.category}
            onChange={(e) => set('category', e.target.value)}
            aria-label="Filtrer par catégorie"
          >
            <option value="">Toutes les catégories</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}

        <select
          className={styles.filterSelect}
          value={state.indexed}
          onChange={(e) => set('indexed', e.target.value as IndexedFilter)}
          aria-label="Filtrer par état d'indexation"
        >
          <option value="all">Tous</option>
          <option value="indexed">Indexés</option>
          <option value="unindexed">Non indexés</option>
        </select>

        <span className={styles.filterCount}>{`${shown} / ${total}`}</span>

        {active && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => onChange(DEFAULT_FILTERS)}
            aria-label="Réinitialiser les filtres"
            title="Réinitialiser les filtres"
          >
            <RotateCcw size={20} />
          </button>
        )}
      </div>
    </div>
  )
}
