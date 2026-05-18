import { AlertCircle, BookOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './App.module.scss'
import { checkHealth, getStoredOllamaUrl, type HealthData } from './api/health'
import { getStoredProvider, type LLMProvider } from './api/llm'
import { useAutoEnrich } from './hooks/useAutoEnrich'
import { useIndexingPass } from './hooks/useIndexingPass'
import { useProviderReadiness } from './hooks/useProviderReadiness'
import { listProjects, type ProjectInfo } from './api/projects'
import { listSources } from './api/papers'
import { getProjectSettings } from './api/settings'
import { canRunIA, type ProviderReadiness } from './utils/providerConfig'
import { AllProjectsView } from './components/layout/AllProjectsView'
import { ApiKeyModal } from './components/modals/ApiKeyModal'
import { AppHeader } from './components/layout/AppHeader'
import { ChatView } from './components/chat/ChatView'
import { DebugPanel } from './components/layout/DebugPanel'
import { DropZone, type FileState } from './components/sources/DropZone'
import { GraphView } from './components/graph/GraphView'
import { ImportProgressToast } from './components/sources/ImportProgressToast'
import { NewProjectView } from './components/layout/NewProjectView'
import { NoProjectState } from './components/layout/NoProjectState'
import { Skeleton } from './components/layout/Skeleton'
import { OllamaSetupModal } from './components/modals/OllamaSetupModal'
import { SourceList } from './components/sources/SourceList'
import {
  DEFAULT_FILTERS,
  type SourceFilterState,
} from './components/sources/SourceList.filters'
import { setCachedSourceCount, clearCachedSourceCount } from './components/sources/SourceList.cache'
import { ProblematiqueView } from './components/problematique/ProblematiqueView'
import { SettingsView } from './components/settings/SettingsView'
import { Sidebar, type View } from './components/layout/Sidebar'

const STORAGE_KEY = 'currentProjectId'

export default function App() {
  const [activeView, setActiveView] = useState<View>('import')
  const [refreshKey, setRefreshKey] = useState(0)
  const [graphRefreshKey, setGraphRefreshKey] = useState(0)
  const [importStates, setImportStates] = useState<FileState[]>([])
  const [openStem, setOpenStem] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilterState>(DEFAULT_FILTERS)

  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectsLoaded, setProjectsLoaded] = useState(false)

  type OllamaStatus = 'checking' | 'connected' | 'unavailable' | 'dismissed'
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('checking')
  const [healthData, setHealthData] = useState<HealthData | null>(null)
  const [apiKeyModalProvider, setApiKeyModalProvider] = useState<Exclude<
    LLMProvider,
    'ollama'
  > | null>(null)
  const [activeProvider, setActiveProvider] = useState<LLMProvider>(() => getStoredProvider())
  const { ollamaHealthy, providerReady } = useProviderReadiness(healthData, activeProvider)

  // canRunIA() derives readiness from localStorage (provider, API key,
  // model) — React doesn't re-render on a localStorage write. So we keep it in
  // state and recompute it explicitly: on Ollama-health changes, on the
  // `storage` event (config changed in another tab/window), and via
  // refreshIaReadiness() right after a same-tab modal save.
  const [iaReadiness, setIaReadiness] = useState<ProviderReadiness>(() => canRunIA(false))
  const refreshIaReadiness = useCallback(() => {
    setIaReadiness(canRunIA(ollamaHealthy))
  }, [ollamaHealthy])
  useEffect(() => {
    refreshIaReadiness()
    window.addEventListener('storage', refreshIaReadiness)
    return () => window.removeEventListener('storage', refreshIaReadiness)
  }, [refreshIaReadiness])
  const importInFlight = importStates.some(
    (f) => f.status === 'queued' || f.status === 'processing'
  )

  const bump = () => {
    setRefreshKey((k) => k + 1)
    setGraphRefreshKey((k) => k + 1)
  }
  const bumpGraph = useCallback(() => setGraphRefreshKey((k) => k + 1), [])

  // Coalesce rapid per-file completions (Zotero ZIP = dozens of files in a
  // few seconds) into a single SourceList refetch, so the list updates a few
  // times per second instead of once per file.
  const bumpDebounceRef = useRef<number | undefined>(undefined)
  const bumpDebounced = useCallback(() => {
    if (bumpDebounceRef.current !== undefined) {
      window.clearTimeout(bumpDebounceRef.current)
    }
    bumpDebounceRef.current = window.setTimeout(() => {
      bumpDebounceRef.current = undefined
      setRefreshKey((k) => k + 1)
    }, 350)
  }, [])

  useEffect(() => {
    return () => {
      if (bumpDebounceRef.current !== undefined) {
        window.clearTimeout(bumpDebounceRef.current)
      }
    }
  }, [])

  // Ingestion is a 3-stage pipeline: import (DropZone, save+parse only) →
  // indexing pass (useIndexingPass, embeds into Chroma) → auto-enrichment
  // (useAutoEnrich, abstract + categories). The indexing pass enqueues each
  // freshly-indexed stem into the enrichment queue. enqueueStem is produced
  // by useAutoEnrich below; a stable ref-backed wrapper breaks the cycle.
  const enqueueRef = useRef<
    ((stem: string, flags: { hasAbstract: boolean; hasCategories: boolean }) => void) | null
  >(null)
  // Effective `auto_enrich` for the current project (project ?? global
  // setting). When false, the indexing pass still runs but does NOT auto-queue
  // the abstract/categories generation — the per-source IA buttons stay.
  const autoEnrichRef = useRef(true)
  const enqueueViaRef = useCallback(
    (stem: string, flags: { hasAbstract: boolean; hasCategories: boolean }) => {
      if (!autoEnrichRef.current) return
      enqueueRef.current?.(stem, flags)
    },
    []
  )
  const {
    start: startIndexing,
    states: indexStates,
    running: indexingRunning,
  } = useIndexingPass(currentProjectId ?? '', enqueueViaRef, bumpDebounced, bumpGraph)
  // Pause auto-enrichment while an import or the indexing pass is in flight:
  // Ollama serves both the embedding pipeline (indexing) and the condense map
  // step (enrichment); running them concurrently saturates the daemon and
  // causes embedding timeouts. The queue drains once both stages settle.
  const { enqueueStem, cancelStem, states: enrichStates } = useAutoEnrich(
    currentProjectId ?? '',
    ollamaHealthy,
    importInFlight || indexingRunning,
    // Refresh the source list (and any open metadata modal) as each
    // enrichment PATCH lands, so generated abstracts/categories show up
    // without a manual page reload.
    bumpDebounced
  )
  enqueueRef.current = enqueueStem

  // Keep the effective auto-enrich flag in sync with the current project's
  // settings — refetched on project switch and after a settings save.
  const refreshProjectSettings = useCallback(() => {
    const pid = currentProjectId
    if (!pid) return
    getProjectSettings(pid)
      .then((b) => {
        autoEnrichRef.current = b.resolved.auto_enrich
      })
      .catch(() => {
        autoEnrichRef.current = true
      })
  }, [currentProjectId])

  useEffect(() => {
    refreshProjectSettings()
  }, [refreshProjectSettings])

  // Full project reindex (after an embedding-model / granularity change in
  // Paramètres). Seeds the progress toast with one row per source, then runs
  // the indexing pass in full-reindex mode — its SSE drives the index badges.
  const handleReindexProject = useCallback(() => {
    const pid = currentProjectId
    if (!pid) return
    listSources(pid)
      .then((sources) => {
        setImportStates(
          sources.map((s) => ({
            filename: s.filename,
            status: 'done' as const,
            stem: s.stem,
            indexed: false,
            // Marks the row as a reindex: the toast shows a spinner instead of
            // a green check until the indexing pass re-indexes this source.
            reindexing: true,
          }))
        )
      })
      .catch(() => {})
      .finally(() => startIndexing({ reindexAll: true }))
  }, [currentProjectId, startIndexing])

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    const dismissed = sessionStorage.getItem('ollamaDismissed') === '1'
    Promise.all([listProjects(), checkHealth(getStoredOllamaUrl() ?? undefined)])
      .then(([list, health]) => {
        setProjects(list)
        if (stored && list.some((p) => p.id === stored)) {
          setCurrentProjectId(stored)
        } else if (list.length > 0) {
          setCurrentProjectId(list[0].id)
        }
        setHealthData(health)
        // Warn whenever Ollama itself is broken, independent of the active
        // provider: the Chat tab and the IA generators are hard-gated on
        // Ollama (embeddings + map step), so a user on Anthropic still loses
        // those features when Ollama is down and deserves to know why.
        const healthy =
          health.ollama === 'connected' && health.ollama_models.every((m) => m.available)
        if (healthy) {
          setOllamaStatus('connected')
        } else if (!dismissed) {
          setOllamaStatus('unavailable')
        } else {
          setOllamaStatus('dismissed')
        }
      })
      .catch(() => {
        setOllamaStatus('dismissed')
      })
      .finally(() => setProjectsLoaded(true))
  }, [])

  useEffect(() => {
    if (currentProjectId !== null) {
      localStorage.setItem(STORAGE_KEY, currentProjectId)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
    // Reset lifted state tied to a specific project so it doesn't leak across
    // projects (e.g. a graph-driven author filter applied to project A would
    // otherwise still be active after switching to project B).
    setOpenStem(null)
    setSourceFilter(DEFAULT_FILTERS)
  }, [currentProjectId])

  function handleProjectSelect(id: string) {
    setCurrentProjectId(id)
    if (activeView === 'new-project' || activeView === 'all-projects') {
      setActiveView('import')
    }
    bump()
  }

  function handleProjectCreated(project: ProjectInfo) {
    // Freshly created project has no sources — pre-warm so the Sources view
    // shows the empty CTA immediately on first navigation, without skeleton flash.
    setCachedSourceCount(project.id, 0)
    setProjects((prev) => [project, ...prev])
    setCurrentProjectId(project.id)
    setActiveView('import')
    bump()
  }

  function handleProjectDeleted(id: string) {
    clearCachedSourceCount(id)
    const next = projects.filter((p) => p.id !== id)
    setProjects(next)
    if (currentProjectId === id) {
      setCurrentProjectId(next[0]?.id ?? null)
    }
  }

  // Hard-gate: Chat view and the IA generators rely on Ollama (chat for the
  // model, /condense for the map step). When it disappears mid-session we
  // bounce the user out of an unreachable view rather than leaving them
  // staring at a broken page.
  useEffect(() => {
    if (!ollamaHealthy && activeView === 'chat') setActiveView('sources')
  }, [ollamaHealthy, activeView])

  const sidebar = (
    <Sidebar
      activeView={activeView}
      onViewChange={setActiveView}
      projects={projects}
      currentProjectId={currentProjectId}
      onProjectSelect={handleProjectSelect}
      loading={!projectsLoaded}
      ollamaAvailable={ollamaHealthy}
    />
  )

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null

  function handleProviderChange(p: LLMProvider) {
    setActiveProvider(p)
    refreshIaReadiness()
    // Switching provider doesn't restore Ollama; the warning is anchored to
    // Ollama's health (Chat tab + IA gen depend on it), so we only silence
    // the modal/banner when Ollama itself is back.
    if (ollamaHealthy) setOllamaStatus('connected')
  }

  const header = (
    <AppHeader
      currentProject={currentProject}
      onConfigureOllama={() => {
        if (!ollamaHealthy) setOllamaStatus('unavailable')
      }}
      onRequestApiKey={setApiKeyModalProvider}
      onProviderChange={handleProviderChange}
    />
  )

  if (!projectsLoaded) {
    return (
      <div className={styles.root}>
        {sidebar}
        {header}
        <main className={styles.content}>
          <div className={styles.skeletonMain}>
            <Skeleton width={280} height={32} radius="var(--radius-md)" />
            <Skeleton width={200} height={16} />
            <Skeleton height={160} radius="var(--radius-lg)" />
          </div>
        </main>
      </div>
    )
  }

  function renderMain() {
    // 'new-project' et 'all-projects' sont accessibles sans projet courant
    if (activeView === 'new-project') {
      return <NewProjectView onCreated={handleProjectCreated} />
    }
    if (activeView === 'all-projects') {
      return (
        <AllProjectsView
          projects={projects}
          currentProjectId={currentProjectId}
          onProjectDeleted={handleProjectDeleted}
        />
      )
    }
    // Toutes les autres vues nécessitent au moins un projet
    if (projects.length === 0 || currentProjectId === null) {
      return <NoProjectState onCreateProject={() => setActiveView('new-project')} />
    }
    const projectId: string = currentProjectId
    return (
      <>
        {activeView === 'import' && (
          <div className={styles.importSection}>
            <div className={styles.importHeader}>
              <BookOpen className={styles.importIcon} />
              <h1 className={styles.importTitle}>Papers Helper</h1>
              <p className={styles.importSubtitle}>Ton outil local de recherche académique</p>
            </div>
            <DropZone
              projectId={projectId}
              onSuccess={() => {
                bump()
                // Import only saved + parsed the files; kick off the indexing
                // pass, which then chains into auto-enrichment per stem.
                startIndexing()
              }}
              onProgress={setImportStates}
              onFileCompleted={() => bumpDebounced()}
              onGraphUpdated={bumpGraph}
            />
            {!iaReadiness.ok && (
              <p className={styles.iaNote}>
                {iaReadiness.reason} L'import fonctionne, mais l'indexation et
                l'enrichissement IA seront ignorés tant que ce n'est pas résolu.
              </p>
            )}
          </div>
        )}
        {activeView === 'sources' && (
          <SourceList
            key={projectId}
            projectId={projectId}
            refreshKey={refreshKey}
            ollamaReady={providerReady}
            ollamaAvailable={ollamaHealthy}
            inFlightImports={importStates}
            onDelete={bump}
            // SourceList already refetches its own list inside handleReindex;
            // a reindex only needs the *graph* refreshed here. Using `bump`
            // would also bump `refreshKey`, firing a second, identical
            // GET /papers/ via SourceList's refreshKey effect.
            onReindexed={bumpGraph}
            onRequestImport={() => setActiveView('import')}
            onEnqueueEnrich={enqueueStem}
            onCancelEnrich={cancelStem}
            openStem={openStem}
            onChangeOpenStem={setOpenStem}
            filterState={sourceFilter}
            onChangeFilterState={setSourceFilter}
          />
        )}
        {activeView === 'problematique' && <ProblematiqueView projectId={projectId} />}
        {activeView === 'chat' && (
          <ChatView
            projectId={projectId}
            provider={activeProvider}
            onConfigureOllama={() => {
              if (!ollamaHealthy) setOllamaStatus('unavailable')
            }}
            onRequestApiKey={setApiKeyModalProvider}
          />
        )}
        {activeView === 'graph' && (
          <GraphView
            projectId={projectId}
            refreshKey={graphRefreshKey}
            onOpenSource={(stem, label) => {
              setOpenStem(stem)
              // Seed the SourceList text search with the paper title so the
              // clicked source surfaces there even if a stale filter would
              // otherwise hide it; clear the other filters for the same reason.
              setSourceFilter({ ...DEFAULT_FILTERS, search: label })
              setActiveView('sources')
            }}
            onFilterSources={(filter) => {
              setSourceFilter({
                ...DEFAULT_FILTERS,
                author: filter.author ?? '',
                category: filter.category ?? '',
              })
              setActiveView('sources')
            }}
          />
        )}
        {activeView === 'settings' && (
          <SettingsView
            projectId={projectId}
            onSaved={refreshProjectSettings}
            onReindex={handleReindexProject}
          />
        )}
        {activeView === 'debug' && <DebugPanel projectId={projectId} refreshKey={refreshKey} />}
      </>
    )
  }

  return (
    <div className={styles.root}>
      {sidebar}
      {header}
      <main className={styles.content}>
        {ollamaStatus === 'dismissed' && (
          <div className={styles.ollamaBanner}>
            <AlertCircle size={14} />
            Ollama n'est pas disponible — certaines fonctionnalités ne fonctionneront pas.
            <button onClick={() => setOllamaStatus('unavailable')}>Reconfigurer</button>
          </div>
        )}
        {renderMain()}
      </main>
      <ImportProgressToast
        fileStates={importStates}
        indexStates={indexStates}
        enrichStates={enrichStates}
        onDismiss={() => setImportStates([])}
      />
      {ollamaStatus === 'unavailable' && (
        <OllamaSetupModal
          healthData={healthData}
          onConnected={(health) => {
            setHealthData(health)
            setOllamaStatus('connected')
            refreshIaReadiness()
          }}
          onDismiss={() => setOllamaStatus('dismissed')}
        />
      )}
      {apiKeyModalProvider && (
        <ApiKeyModal
          provider={apiKeyModalProvider}
          onSave={() => {
            setApiKeyModalProvider(null)
            refreshIaReadiness()
            // The Ollama warning isn't about provider keys — only silence it
            // when Ollama itself is healthy.
            if (ollamaHealthy) {
              setOllamaStatus('connected')
            }
          }}
          onClose={() => setApiKeyModalProvider(null)}
        />
      )}
    </div>
  )
}
