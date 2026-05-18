import { ChevronDown, ChevronUp, Network, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, GraphNodeType, GraphStreamEvent } from '../../api/graph'
import { rebuildGraph, syncGraph } from '../../api/graph'
import { useGraph } from '../../hooks/useGraph'
import { readSseEvents } from '../../utils/sse'
import { Skeleton } from '../layout/Skeleton'
import type { CanvasPosition } from './GraphCanvas'
import { DEFAULT_FILTERS, FilterState, GraphFilters } from './GraphFilters'
import { GraphNodeFooter } from './GraphNodeFooter'
import { GraphNodePopover } from './GraphNodePopover'
import styles from './GraphView.module.scss'

interface RebuildProgress {
  /** Index of the most recently processed source (1-based). */
  current: number
  /** Total number of sources to process for the current run. */
  total: number
  /** Stem of the most recently processed source — surfaced as a hint. */
  stem: string
}

/** Drain a rebuild / sync stream, collecting both skipped stems and
 * progress ticks. Progress is reported to the optional callback so the
 * caller can render a live counter without buffering the whole stream. */
async function consumeRebuildStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (p: RebuildProgress) => void
): Promise<{ stem: string; reason: string }[]> {
  const skipped: { stem: string; reason: string }[] = []
  await readSseEvents<GraphStreamEvent>(body, (ev) => {
    if (ev.type === 'graph_start' && onProgress) {
      onProgress({ current: 0, total: ev.total, stem: '' })
      return
    }
    if (ev.type !== 'graph_result') return
    if (onProgress) {
      onProgress({ current: ev.index, total: ev.total, stem: ev.stem })
    }
    if (ev.added !== false) return
    if (!ev.stem) return
    skipped.push({ stem: ev.stem, reason: ev.reason || 'unknown' })
  })
  return skipped
}

const SKIP_REASON_LABEL: Record<string, string> = {
  no_sidecar: 'sidecar manquant',
  unknown: 'raison inconnue',
}

// Lazy-load the canvas so cytoscape ships in its own chunk; the graph view is
// off the critical path of the app.
const GraphCanvas = lazy(() => import('./GraphCanvas').then((m) => ({ default: m.GraphCanvas })))

interface Props {
  projectId: string
  refreshKey: number
  onOpenSource: (stem: string, label: string) => void
  onFilterSources: (filter: { author?: string; category?: string }) => void
}

export function GraphView({ projectId, refreshKey, onOpenSource, onFilterSources }: Props) {
  const { graph, loading, error, refresh } = useGraph(projectId, refreshKey)
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNodePos, setSelectedNodePos] = useState<CanvasPosition | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState<RebuildProgress | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Stems the backend reported as added=false during the most recent rebuild
  // or sync. Surfaced as a small pill in the header so the user doesn't have
  // to dig through logs to understand why a file didn't enter the graph.
  const [skippedStems, setSkippedStems] = useState<{ stem: string; reason: string }[]>([])
  // Track which projects we already auto-synced this session so we don't
  // fire the sync twice on the same mount cycle (refetches caused by
  // `graph_updated` events would otherwise re-trigger it).
  const syncedProjectsRef = useRef<Set<string>>(new Set())
  // Seed the semantic-threshold slider from the backend exactly once per
  // mount. After that, the slider belongs to the user — re-fetches of the
  // same graph must not snap it back to the backend default.
  const seededThresholdRef = useRef(false)
  useEffect(() => {
    if (seededThresholdRef.current) return
    const backendThreshold = graph?.semantic_threshold
    if (typeof backendThreshold !== 'number') return
    seededThresholdRef.current = true
    setFilters((f) => ({ ...f, semanticThreshold: backendThreshold }))
  }, [graph?.semantic_threshold])

  // After the initial fetch settles, if the graph is smaller than the
  // sources actually present on disk, fire a background sync. Idempotent:
  // a no-op stream returns instantly when nothing is missing.
  useEffect(() => {
    if (!graph || !projectId) return
    if (syncing) return
    if (syncedProjectsRef.current.has(projectId)) return
    const paperCount = graph.stats.nodes.paper ?? 0
    if (paperCount >= graph.source_count) {
      // Already in sync — still flag the project so a transient empty
      // response doesn't re-trigger later.
      syncedProjectsRef.current.add(projectId)
      return
    }
    syncedProjectsRef.current.add(projectId)
    setSyncing(true)
    ;(async () => {
      try {
        const body = await syncGraph(projectId)
        const skipped = await consumeRebuildStream(body)
        if (skipped.length > 0) setSkippedStems(skipped)
        refresh()
      } catch (err) {
        console.warn('Graph sync failed', err)
      } finally {
        setSyncing(false)
      }
    })()
  }, [graph, projectId, refresh, syncing])

  const paperIdToLabel = useMemo(() => {
    const map = new Map<string, string>()
    graph?.nodes.forEach((n) => {
      if (n.type === 'paper') map.set(n.id, n.label)
    })
    return map
  }, [graph])

  const selectedNode: GraphNode | null = useMemo(() => {
    if (!selectedNodeId || !graph) return null
    return graph.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [graph, selectedNodeId])

  const neighborSummaries = useMemo(() => {
    if (!selectedNode || !graph) return []
    const seen = new Set<string>()
    const out: { id: string; label: string; type: GraphNodeType }[] = []
    for (const edge of graph.edges) {
      const otherId =
        edge.source === selectedNode.id
          ? edge.target
          : edge.target === selectedNode.id
            ? edge.source
            : null
      if (!otherId || seen.has(otherId)) continue
      // Don't double-list paper neighbours from semantic edges in the generic
      // "Voisins" list — they have a dedicated section in the footer.
      if (selectedNode.type === 'paper' && edge.type === 'semantic') continue
      const node = graph.nodes.find((n) => n.id === otherId)
      if (!node) continue
      seen.add(otherId)
      out.push({ id: node.id, label: node.label, type: node.type })
    }
    return out
  }, [graph, selectedNode])

  const counts = graph?.stats.nodes ?? {}

  async function handleRebuild() {
    if (rebuilding) return
    setRebuilding(true)
    setRebuildProgress(null)
    // A rebuild restarts from scratch — drop any stale skip list before
    // collecting the new one so the pill reflects only the latest run.
    setSkippedStems([])
    try {
      const body = await rebuildGraph(projectId)
      const skipped = await consumeRebuildStream(body, setRebuildProgress)
      if (skipped.length > 0) setSkippedStems(skipped)
    } catch (err) {
      console.error('Rebuild failed', err)
    } finally {
      setRebuilding(false)
      setRebuildProgress(null)
      refresh()
    }
  }

  function clearSelection() {
    setSelectedNodeId(null)
    setSelectedNodePos(null)
  }

  const showEmpty = !loading && graph && graph.nodes.length === 0 && !syncing
  const missingFromGraph = graph
    ? Math.max(0, graph.source_count - (graph.stats.nodes.paper ?? 0))
    : 0

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>
          <Network size={20} /> Graph
        </h1>
        <div className={styles.actions}>
          {graph && (
            <div className={styles.stats}>
              <span className={styles.statPill}>
                {graph.stats.node_total ?? 0} nœuds et {graph.stats.edge_total ?? 0} arêtes
              </span>
              {syncing && (
                <span className={styles.statPill}>Synchronisation des sources existantes…</span>
              )}
              {!syncing && missingFromGraph > 0 && (
                <span className={styles.statPill}>{missingFromGraph} source(s) à intégrer</span>
              )}
              {skippedStems.length > 0 && (
                <span
                  className={styles.statPill}
                  title={skippedStems
                    .map(
                      (s) => `${s.stem} — ${SKIP_REASON_LABEL[s.reason] ?? s.reason}`
                    )
                    .join('\n')}
                >
                  {skippedStems.length} source(s) ignorée(s)
                </span>
              )}
              {graph.embed_model && (
                <span className={styles.statPill}>embed&nbsp;: {graph.embed_model}</span>
              )}
            </div>
          )}
          <button
            type="button"
            className={styles.button}
            onClick={handleRebuild}
            disabled={rebuilding}
          >
            <RefreshCw size={16} />
            {rebuilding
              ? rebuildProgress && rebuildProgress.total > 0
                ? `Reconstruction… ${rebuildProgress.current}/${rebuildProgress.total}`
                : 'Reconstruction…'
              : 'Reconstruire'}
          </button>
        </div>
      </div>

      <div className={styles.canvas}>
        {rebuilding && rebuildProgress && rebuildProgress.total > 0 && (
          <div
            className={styles.progressBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={rebuildProgress.total}
            aria-valuenow={rebuildProgress.current}
          >
            <div
              className={styles.progressFill}
              style={{
                width: `${Math.min(
                  100,
                  (rebuildProgress.current / rebuildProgress.total) * 100
                )}%`,
              }}
            />
            <span className={styles.progressLabel}>
              {rebuildProgress.current}/{rebuildProgress.total}
              {rebuildProgress.stem ? ` — ${rebuildProgress.stem}` : ''}
            </span>
          </div>
        )}
        {loading && (
          <div className={styles.empty}>
            <Skeleton width={280} height={32} radius="var(--radius-md)" />
            <Skeleton width={200} height={16} />
          </div>
        )}
        {error && !loading && (
          <div className={styles.empty}>
            <p className={styles.error}>Erreur : {error}</p>
            <button
              type="button"
              className={styles.retryButton}
              onClick={refresh}
              aria-label="Réessayer le chargement du graphe"
            >
              <RefreshCw size={16} /> Réessayer
            </button>
          </div>
        )}
        {graph?.corrupt && (
          <div className={styles.empty}>
            <p className={styles.error}>
              Le fichier <code>graph.json</code> est dans un format inconnu. Lance une
              reconstruction pour le régénérer.
            </p>
          </div>
        )}
        {showEmpty && !graph?.corrupt && (
          <div className={styles.empty}>
            <p>
              Aucun graphe pour l’instant. Importe des sources pour qu’il se construise
              automatiquement.
            </p>
          </div>
        )}
        {syncing && graph && graph.nodes.length === 0 && (
          <div className={styles.empty}>
            <p>Synchronisation des sources existantes en cours…</p>
          </div>
        )}
        {graph && graph.nodes.length > 0 && !graph.corrupt && (
          <Suspense fallback={<div className={styles.empty}>Chargement du canvas…</div>}>
            <GraphCanvas
              graph={graph}
              filters={filters}
              selectedNodeId={selectedNodeId}
              onNodeClick={(id, pos) => {
                setSelectedNodeId(id)
                setSelectedNodePos(pos)
              }}
              onBackgroundClick={clearSelection}
              onSelectedPositionChange={setSelectedNodePos}
            />
          </Suspense>
        )}

        {/* Floating filters menu, anchored top-left inside the canvas. */}
        {graph && graph.nodes.length > 0 && !graph.corrupt && (
          <div className={styles.filtersFloating}>
            <button
              type="button"
              className={styles.filtersToggle}
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-label="Filtres"
              title="Filtres"
            >
              <SlidersHorizontal size={16} /> Filtres
              {filtersOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>
            {filtersOpen && (
              <div className={styles.filtersPanel}>
                <GraphFilters filters={filters} onChange={setFilters} counts={counts} />
              </div>
            )}
          </div>
        )}

        {selectedNode && selectedNodePos && (
          <GraphNodePopover
            node={selectedNode}
            position={selectedNodePos}
            onOpenSource={onOpenSource}
            onFilterSources={onFilterSources}
            onClose={clearSelection}
          />
        )}

        {selectedNode && (
          <GraphNodeFooter
            node={selectedNode}
            neighbors={neighborSummaries}
            paperIdToLabel={paperIdToLabel}
            semanticEdges={graph?.edges.filter((e) => e.type === 'semantic') ?? []}
            onPickNode={(id) => setSelectedNodeId(id)}
          />
        )}
      </div>
    </div>
  )
}
