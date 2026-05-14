import { AlertCircle, BookOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './App.module.scss'
import { checkHealth, getStoredOllamaUrl, type HealthData } from './api/health'
import { getStoredProvider, type LLMProvider } from './api/llm'
import { useProviderReadiness } from './hooks/useProviderReadiness'
import { listProjects, type ProjectInfo } from './api/projects'
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
              onSuccess={bump}
              onProgress={setImportStates}
              onFileCompleted={bumpDebounced}
              onGraphUpdated={bumpGraph}
            />
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
            onReindexed={bump}
            onRequestImport={() => setActiveView('import')}
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
            onOpenSource={(stem) => {
              setOpenStem(stem)
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
      <ImportProgressToast fileStates={importStates} onDismiss={() => setImportStates([])} />
      {ollamaStatus === 'unavailable' && (
        <OllamaSetupModal
          healthData={healthData}
          onConnected={(health) => {
            setHealthData(health)
            setOllamaStatus('connected')
          }}
          onDismiss={() => setOllamaStatus('dismissed')}
        />
      )}
      {apiKeyModalProvider && (
        <ApiKeyModal
          provider={apiKeyModalProvider}
          onSave={() => {
            setApiKeyModalProvider(null)
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
