import { useCallback, useEffect, useMemo, useState } from 'react'
import { Upload } from 'lucide-react'
import { deleteSource, listSources, reindexSource, type SourceInfo } from '../../api/papers'
import { splitCategoriesCsv } from '../../utils/categories'
import { readSseEvents } from '../../utils/sse'
import { MetadataModal } from './MetadataModal'
import { Skeleton } from '../layout/Skeleton'
import type { FileState } from './DropZone'
import { ImportingCard } from './ImportingCard'
import { SourceCard } from './SourceCard'
import { SourceFilters } from './SourceFilters'
import { readCachedSourceCount, setCachedSourceCount } from './SourceList.cache'
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
  /**
   * Forwarded to MetadataModal's IA button (hard-gate). Distinct from
   * `ollamaReady`, which reflects the *active provider's* readiness — the
   * abstract generator specifically needs Ollama for the map step regardless
   * of which provider runs the reduce.
   */
  ollamaAvailable?: boolean
  inFlightImports?: FileState[]
  onDelete?: () => void
  onReindexed?: () => void
  onRequestImport?: () => void
  /** Optional auto-enrichment hook from App. When provided, every reindexed
   * source whose abstract/categories are still empty is enqueued for IA
   * generation — same contract as the initial-import flow. */
  onEnqueueEnrich?: (
    stem: string,
    flags: { hasAbstract: boolean; hasCategories: boolean }
  ) => void
  /** Counterpart to `onEnqueueEnrich`: drops a source from the auto-enrich
   * queue (and aborts it if running) when the source is deleted, so a
   * deleted paper is never re-patched into an orphan metadata sidecar. */
  onCancelEnrich?: (stem: string) => void
  /** Optionally lift the "currently-open preview" stem to a parent so other
   * features (e.g. clicking a node in the graph) can drive it. When omitted,
   * SourceList manages it locally. */
  openStem?: string | null
  onChangeOpenStem?: (stem: string | null) => void
  /** Optionally lift the filter state to a parent so the graph view can apply
   * an author/category filter before switching to the Sources view. When
   * omitted, SourceList manages it locally. */
  filterState?: SourceFilterState
  onChangeFilterState?: (next: SourceFilterState) => void
}

export function SourceList({
  projectId,
  refreshKey,
  ollamaReady = true,
  ollamaAvailable = true,
  inFlightImports,
  onDelete,
  onReindexed,
  onRequestImport,
  onEnqueueEnrich,
  onCancelEnrich,
  openStem: openStemProp,
  onChangeOpenStem,
  filterState: filterStateProp,
  onChangeFilterState,
}: SourceListProps) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmStem, setConfirmStem] = useState<string | null>(null)
  const [deletingStem, setDeletingStem] = useState<string | null>(null)
  const [reindexingStem, setReindexingStem] = useState<string | null>(null)
  const [editingSource, setEditingSource] = useState<SourceInfo | null>(null)
  const [openStemLocal, setOpenStemLocal] = useState<string | null>(null)
  const openStem = openStemProp !== undefined ? openStemProp : openStemLocal
  const setOpenStem = (next: string | null) => {
    onChangeOpenStem?.(next)
    if (openStemProp === undefined) setOpenStemLocal(next)
  }
  const [networkError, setNetworkError] = useState<string | null>(null)
  const [filterStateLocal, setFilterStateLocal] = useState<SourceFilterState>(DEFAULT_FILTERS)
  const filterState = filterStateProp ?? filterStateLocal
  const setFilterState = (next: SourceFilterState) => {
    onChangeFilterState?.(next)
    if (filterStateProp === undefined) setFilterStateLocal(next)
  }
  // Captured at mount; refreshed when projectId changes. Used only to bias
  // the *initial* loading render (skeletons vs. empty CTA).
  const [cachedCount, setCachedCount] = useState<number | null>(() =>
    readCachedSourceCount(projectId)
  )

  useEffect(() => {
    setCachedCount(readCachedSourceCount(projectId))
    // Only reset the local fallback here. When the parent owns the filter
    // state, it is responsible for resetting on project change (App.tsx does
    // this in its own `currentProjectId` effect).
    if (filterStateProp === undefined) setFilterStateLocal(DEFAULT_FILTERS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const fetchSources = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listSources(projectId)
      setSources(data)
      // Keep an open metadata modal pointed at the fresh row, so background
      // enrichment (abstract / categories) shows up live instead of after a
      // manual page reload. Falls back to the current object if the source
      // vanished (e.g. deleted) so the modal doesn't break.
      setEditingSource((cur) => (cur ? (data.find((s) => s.stem === cur.stem) ?? cur) : cur))
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
      // Stop any pending/in-flight enrichment first: a PATCH landing after
      // the delete would resurrect the source's metadata sidecar as an orphan.
      onCancelEnrich?.(stem)
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
    let enrichFlags: { hasAbstract: boolean; hasCategories: boolean } | null = null
    try {
      const res = await reindexSource(projectId, stem)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Capture the result event (carries has_abstract / has_categories) so
      // we can enqueue auto-enrichment after the refetch. Reindex emits
      // start → result → done for a single stem.
      if (res.body) {
        await readSseEvents<{
          type: string
          stem?: string
          has_abstract?: boolean
          has_categories?: boolean
          indexed?: boolean
        }>(res.body, (event) => {
          if (event.type === 'result' && event.indexed !== false) {
            enrichFlags = {
              hasAbstract: event.has_abstract ?? false,
              hasCategories: event.has_categories ?? false,
            }
          }
        })
      }
      await fetchSources()
      onReindexed?.()
      if (enrichFlags) onEnqueueEnrich?.(stem, enrichFlags)
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

  // Compute categories ONCE per source list; reused for the dropdown and the
  // per-row filter check so we don't re-parse on every keystroke.
  const categoriesByStem = useMemo(() => {
    const map = new Map<string, readonly string[]>()
    for (const s of sources) {
      map.set(s.stem, splitCategoriesCsv(s.categories))
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

  // Empty state requires an actually-empty list. The `cachedCount === 0` term
  // only biases the *cold* load (no data on screen yet) toward the CTA instead
  // of skeletons — it must never fire during a warm refetch. A state change on
  // one card (importé → indexation) bumps `refreshKey`, which flips `loading`
  // true again; without the `sources.length === 0` guard the whole section
  // would flash the empty CTA while the cards are still rendered.
  const showEmptyCta =
    pendingImports.length === 0 &&
    sources.length === 0 &&
    (!loading || cachedCount === 0)

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
          ollamaAvailable={ollamaAvailable}
        />
      )}
    </div>
  )
}

