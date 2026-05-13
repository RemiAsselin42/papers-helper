import { useCallback, useEffect, useMemo, useState } from 'react'
import { Upload } from 'lucide-react'
import { deleteSource, listSources, reindexSource, type SourceInfo } from '../api/projects'
import { extractBibtexCategories } from '../utils'
import { MetadataModal } from './MetadataModal'
import { Skeleton } from './Skeleton'
import type { FileState } from './DropZone'
import { ImportingCard } from './ImportingCard'
import { SourceCard } from './SourceCard'
import { SourceFilters } from './SourceFilters'
import {
  DEFAULT_FILTERS,
  filterSources,
  isFilterActive,
  NO_YEAR_VALUE,
  resolveType,
  type SourceFilterState,
} from './SourceList.filters'
import styles from './SourceList.module.scss'

interface SourceListProps {
  projectId: string
  refreshKey?: number
  ollamaReady?: boolean
  inFlightImports?: FileState[]
  onDelete?: () => void
  onReindexed?: () => void
  onRequestImport?: () => void
}

// Cached source count per project. Used to pick the right initial render
// (empty CTA vs. skeletons) before the network fetch resolves — avoids both
// the empty-flash-then-list and the skeleton-flash-then-empty UX glitches.
const SOURCE_COUNT_CACHE_PREFIX = 'sourceCount:'

function readCachedSourceCount(projectId: string): number | null {
  try {
    const raw = localStorage.getItem(SOURCE_COUNT_CACHE_PREFIX + projectId)
    if (raw === null) return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export function setCachedSourceCount(projectId: string, count: number): void {
  try {
    localStorage.setItem(SOURCE_COUNT_CACHE_PREFIX + projectId, String(count))
  } catch {
    // Storage is best-effort; skip silently on quota / disabled storage.
  }
}

export function clearCachedSourceCount(projectId: string): void {
  try {
    localStorage.removeItem(SOURCE_COUNT_CACHE_PREFIX + projectId)
  } catch {
    // Same rationale as setCachedSourceCount.
  }
}

export function SourceList({
  projectId,
  refreshKey,
  ollamaReady = true,
  inFlightImports,
  onDelete,
  onReindexed,
  onRequestImport,
}: SourceListProps) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmStem, setConfirmStem] = useState<string | null>(null)
  const [deletingStem, setDeletingStem] = useState<string | null>(null)
  const [reindexingStem, setReindexingStem] = useState<string | null>(null)
  const [editingSource, setEditingSource] = useState<SourceInfo | null>(null)
  const [openStem, setOpenStem] = useState<string | null>(null)
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [filterState, setFilterState] = useState<SourceFilterState>(DEFAULT_FILTERS)
  // Captured at mount; refreshed when projectId changes. Used only to bias
  // the *initial* loading render (skeletons vs. empty CTA).
  const [cachedCount, setCachedCount] = useState<number | null>(() =>
    readCachedSourceCount(projectId)
  )

  useEffect(() => {
    setCachedCount(readCachedSourceCount(projectId))
    setFilterState(DEFAULT_FILTERS)
  }, [projectId])

  const fetchSources = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listSources(projectId)
      setSources(data)
      setNetworkError(null)
      setCachedSourceCount(projectId, data.length)
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'Erreur réseau')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchSources()
  }, [refreshKey, fetchSources])

  async function handleConfirmDelete(stem: string) {
    setDeletingStem(stem)
    try {
      await deleteSource(projectId, stem)
      setSources((s) => {
        const next = s.filter((x) => x.stem !== stem)
        setCachedSourceCount(projectId, next.length)
        return next
      })
      if (openStem === stem) setOpenStem(null)
      onDelete?.()
    } finally {
      setDeletingStem(null)
      setConfirmStem(null)
    }
  }

  function handleSaved(updated: SourceInfo) {
    setSources((s) => s.map((x) => (x.stem === updated.stem ? updated : x)))
    setEditingSource(null)
  }

  async function handleReindex(stem: string) {
    setReindexingStem(stem)
    try {
      const res = await reindexSource(projectId, stem)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Drain the SSE stream — the backend emits result + done; we don't need
      // intermediate events here, just wait for completion before refetching.
      if (res.body) {
        const reader = res.body.getReader()
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      await fetchSources()
      onReindexed?.()
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'Erreur lors de la réindexation')
    } finally {
      setReindexingStem(null)
    }
  }

  // In-flight imports that don't yet have a backend row. Once the source
  // appears in `sources` (matched by filename or stem), the synthetic row is
  // dropped and the real card takes over.
  const pendingImports = useMemo<FileState[]>(() => {
    if (!inFlightImports || inFlightImports.length === 0) return []
    const knownFilenames = new Set(sources.map((s) => s.filename))
    const knownStems = new Set(sources.map((s) => s.stem))
    return inFlightImports.filter((f) => {
      // ZIP archives and BibTeX manifests are packaging, not sources — the
      // real files they contain stream in as separate FileStates.
      if (f.extracted_count !== undefined || f.items_parsed !== undefined) return false
      const lower = f.filename.toLowerCase()
      if (lower.endsWith('.zip') || lower.endsWith('.bib')) return false
      // Synthetic rows are only useful while the file isn't yet a real source.
      if (f.status === 'done' && (knownFilenames.has(f.filename) || knownStems.has(f.filename))) {
        return false
      }
      return (
        f.status === 'queued' ||
        f.status === 'processing' ||
        f.status === 'error' ||
        f.status === 'done'
      )
    })
  }, [inFlightImports, sources])

  // Compute BibTeX categories ONCE per source list; reused for the dropdown
  // and the per-row filter check so we don't re-parse on every keystroke.
  const categoriesByStem = useMemo(() => {
    const map = new Map<string, readonly string[]>()
    for (const s of sources) {
      map.set(s.stem, extractBibtexCategories(s.pdf_title))
    }
    return map
  }, [sources])

  const availableTypes = useMemo(
    () => Array.from(new Set(sources.map((s) => resolveType(s)))).sort(),
    [sources]
  )
  const availableYears = useMemo(() => {
    const raw = Array.from(new Set(sources.map((s) => s.year || NO_YEAR_VALUE)))
    const real = raw.filter((y) => y !== NO_YEAR_VALUE).sort((a, b) => b.localeCompare(a))
    return raw.includes(NO_YEAR_VALUE) ? [...real, NO_YEAR_VALUE] : real
  }, [sources])
  const availableCategories = useMemo(() => {
    const set = new Set<string>()
    for (const cats of categoriesByStem.values()) {
      for (const c of cats) set.add(c)
    }
    return Array.from(set).sort()
  }, [categoriesByStem])

  const filteredSources = useMemo(
    () => filterSources(sources, filterState, categoriesByStem),
    [sources, filterState, categoriesByStem]
  )

  // Empty state is shown both when the fetch resolved with zero sources AND
  // (optimistically) on initial load if the cached count says the project
  // is empty — avoids a skeleton flash before the empty CTA.
  const showEmptyCta =
    pendingImports.length === 0 &&
    ((!loading && sources.length === 0) || (loading && cachedCount === 0))

  // Skeletons only on a *cold* load — once we have data on screen, keep it
  // visible during refetches so rapid imports don't flicker the whole list.
  const isColdLoad = loading && sources.length === 0
  if (isColdLoad && !showEmptyCta) {
    const skeletonCount = cachedCount && cachedCount > 0 ? cachedCount : 3
    return (
      <div className={styles.skeletonList}>
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <div key={i} className={styles.skeletonCard}>
            <Skeleton width={64} height={22} />
            <div className={styles.skeletonMeta}>
              <Skeleton height={20} />
              <Skeleton width="55%" height={14} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (networkError) return <p className={styles.networkError}>{networkError}</p>
  if (showEmptyCta) {
    return (
      <div className={styles.emptyCta}>
        <Upload size={48} className={styles.emptyCtaIcon} aria-hidden="true" />
        <p className={styles.emptyCtaText}>Aucune source pour l'instant</p>
        {onRequestImport ? (
          <button type="button" className={styles.emptyCtaButton} onClick={onRequestImport}>
            Importer une source
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className={styles.scrollHost}>
      <SourceFilters
        state={filterState}
        onChange={setFilterState}
        availableTypes={availableTypes}
        availableYears={availableYears}
        availableCategories={availableCategories}
        total={sources.length}
        shown={filteredSources.length}
      />

      {filteredSources.length === 0 &&
      pendingImports.length === 0 &&
      isFilterActive(filterState) ? (
        <div className={styles.filterEmpty}>
          <span>Aucune source ne correspond aux filtres.</span>
          <button
            type="button"
            className={styles.filterEmptyReset}
            onClick={() => setFilterState(DEFAULT_FILTERS)}
          >
            Réinitialiser
          </button>
        </div>
      ) : null}

      <ul className={styles.list}>
        {pendingImports.map((f) => (
          <ImportingCard key={`pending:${f.filename}`} file={f} />
        ))}
        {filteredSources.map((s) => (
          <SourceCard
            key={s.stem}
            projectId={projectId}
            source={s}
            isOpen={openStem === s.stem}
            isConfirming={confirmStem === s.stem}
            isDeleting={deletingStem === s.stem}
            isReindexing={reindexingStem === s.stem}
            ollamaReady={ollamaReady}
            onTogglePreview={(stem) => setOpenStem(openStem === stem ? null : stem)}
            onRequestConfirmDelete={(stem) => setConfirmStem(stem)}
            onCancelConfirmDelete={() => setConfirmStem(null)}
            onConfirmDelete={handleConfirmDelete}
            onReindex={handleReindex}
            onEdit={setEditingSource}
          />
        ))}
      </ul>

      {editingSource && (
        <MetadataModal
          projectId={projectId}
          source={editingSource}
          onSave={handleSaved}
          onClose={() => setEditingSource(null)}
        />
      )}
    </div>
  )
}

// Re-export so call sites that imported from './SourceList' previously still work
// during the split. (filterSources is also useful for tests.)
export { filterSources } from './SourceList.filters'
