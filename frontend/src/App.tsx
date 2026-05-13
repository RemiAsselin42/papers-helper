import { AlertCircle, BookOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './App.module.scss'
import { checkHealth, getStoredOllamaUrl, type HealthData } from './api/health'
import { getStoredProvider, isActiveProviderReady, type LLMProvider } from './api/llm'
import { useProviderReadiness } from './hooks/useProviderReadiness'
import { listProjects, type ProjectInfo } from './api/projects'
import { AllProjectsView } from './components/layout/AllProjectsView'
import { ApiKeyModal } from './components/modals/ApiKeyModal'
import { AppHeader } from './components/layout/AppHeader'
import { ChatView } from './components/chat/ChatView'
import { DebugPanel } from './components/layout/DebugPanel'
import { DropZone, type FileState } from './components/sources/DropZone'
import { ImportProgressToast } from './components/sources/ImportProgressToast'
import { NewProjectView } from './components/layout/NewProjectView'
import { NoProjectState } from './components/layout/NoProjectState'
import { Skeleton } from './components/layout/Skeleton'
import { OllamaSetupModal } from './components/modals/OllamaSetupModal'
import { SourceList } from './components/sources/SourceList'
import { setCachedSourceCount, clearCachedSourceCount } from './components/sources/SourceList.cache'
import { ProblematiqueView } from './components/problematique/ProblematiqueView'
import { Sidebar, type View } from './components/layout/Sidebar'

const STORAGE_KEY = 'currentProjectId'

export default function App() {
  const [activeView, setActiveView] = useState<View>('import')
  const [refreshKey, setRefreshKey] = useState(0)
  const [importStates, setImportStates] = useState<FileState[]>([])

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

  const bump = () => setRefreshKey((k) => k + 1)

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
        // Modal only matters when the active provider isn't ready — i.e. user
        // picked Ollama and it's broken, OR they picked an external provider
        // but haven't saved a key yet. We can't read the hook output here
        // (it's derived from the healthData we just set), so inline the check.
        const healthy =
          health.ollama === 'connected' && health.ollama_models.every((m) => m.available)
        if (isActiveProviderReady(healthy)) {
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

  const sidebar = (
    <Sidebar
      activeView={activeView}
      onViewChange={setActiveView}
      projects={projects}
      currentProjectId={currentProjectId}
      onProjectSelect={handleProjectSelect}
      loading={!projectsLoaded}
    />
  )

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null

  function handleProviderChange(p: LLMProvider) {
    setActiveProvider(p)
    // Re-evaluation runs implicitly via useProviderReadiness; only the status
    // gate flips to 'connected' if the new provider is already usable.
    if (providerReady) setOllamaStatus('connected')
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
            />
          </div>
        )}
        {activeView === 'sources' && (
          <SourceList
            key={projectId}
            projectId={projectId}
            refreshKey={refreshKey}
            ollamaReady={providerReady}
            inFlightImports={importStates}
            onDelete={bump}
            onReindexed={bump}
            onRequestImport={() => setActiveView('import')}
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
            // Saving a key may make the active provider ready — silence the
            // Ollama modal/banner if so.
            if (isActiveProviderReady(ollamaHealthy)) {
              setOllamaStatus('connected')
            }
          }}
          onClose={() => setApiKeyModalProvider(null)}
        />
      )}
    </div>
  )
}
