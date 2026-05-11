import { AlertCircle, BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import styles from './App.module.scss'
import { checkHealth, getStoredOllamaUrl, type HealthData } from './api/health'
import { getStoredProvider, isActiveProviderReady, type LLMProvider } from './api/llm'
import { listProjects, type ProjectInfo } from './api/projects'
import { AllProjectsView } from './components/AllProjectsView'
import { ApiKeyModal } from './components/ApiKeyModal'
import { AppHeader } from './components/AppHeader'
import { ChatView } from './components/ChatView'
import { DebugPanel } from './components/DebugPanel'
import { DropZone, type FileState } from './components/DropZone'
import { ImportProgressToast } from './components/ImportProgressToast'
import { NewProjectView } from './components/NewProjectView'
import { NoProjectState } from './components/NoProjectState'
import { OllamaSetupModal } from './components/OllamaSetupModal'
import { SourceList } from './components/SourceList'
import { ProblematiqueView } from './components/ProblematiqueView'
import { Sidebar, type View } from './components/Sidebar'

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
  const [ollamaModelBump, setOllamaModelBump] = useState(0)

  const bump = () => setRefreshKey(k => k + 1)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    const dismissed = sessionStorage.getItem('ollamaDismissed') === '1'
    Promise.all([
      listProjects(),
      checkHealth(getStoredOllamaUrl() ?? undefined),
    ])
      .then(([list, health]) => {
        setProjects(list)
        if (stored && list.some(p => p.id === stored)) {
          setCurrentProjectId(stored)
        }
        setHealthData(health)
        const ollamaHealthy =
          health.ollama === 'connected' && health.ollama_models.every(m => m.available)
        // Modal only matters when the active provider isn't ready — i.e. user
        // picked Ollama and it's broken, OR they picked an external provider
        // but haven't saved a key yet.
        if (isActiveProviderReady(ollamaHealthy)) {
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
    setProjects(prev => [project, ...prev])
    setCurrentProjectId(project.id)
    setActiveView('import')
    bump()
  }

  function handleProjectDeleted(id: string) {
    setProjects(prev => prev.filter(p => p.id !== id))
    if (currentProjectId === id) {
      setCurrentProjectId(null)
    }
  }

  const sidebar = (
    <Sidebar
      activeView={activeView}
      onViewChange={setActiveView}
      projects={projects}
      currentProjectId={currentProjectId}
      onProjectSelect={handleProjectSelect}
    />
  )

  const currentProject = projects.find(p => p.id === currentProjectId) ?? null

  function reevaluateOllamaStatus() {
    const ollamaHealthy =
      healthData?.ollama === 'connected' &&
      healthData.ollama_models.every(m => m.available)
    if (isActiveProviderReady(!!ollamaHealthy)) {
      setOllamaStatus('connected')
    }
  }

  function handleProviderChange(p: LLMProvider) {
    setActiveProvider(p)
    reevaluateOllamaStatus()
  }

  const ollamaHealthy =
    healthData?.ollama === 'connected' &&
    healthData.ollama_models.every(m => m.available)

  const header = (
    <AppHeader
      currentProject={currentProject}
      onConfigureOllama={() => {
        if (!ollamaHealthy) setOllamaStatus('unavailable')
      }}
      onRequestApiKey={setApiKeyModalProvider}
      onProviderChange={handleProviderChange}
      onOllamaModelChange={() => setOllamaModelBump(b => b + 1)}
    />
  )

  if (!projectsLoaded) {
    return (
      <div className={styles.root}>
        {sidebar}
        {header}
        <main className={styles.content} />
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
            <DropZone projectId={projectId} onSuccess={bump} onProgress={setImportStates} />
          </div>
        )}
        {activeView === 'sources' && (
          <SourceList projectId={projectId} refreshKey={refreshKey} onDelete={bump} />
        )}
        {activeView === 'problematique' && (
          <ProblematiqueView projectId={projectId} />
        )}
        {activeView === 'chat' && (
          <ChatView
            projectId={projectId}
            provider={activeProvider}
            ollamaModelBump={ollamaModelBump}
            onResumeProvider={handleProviderChange}
            onResumeOllamaModel={() => setOllamaModelBump(b => b + 1)}
          />
        )}
        {activeView === 'debug' && (
          <DebugPanel projectId={projectId} refreshKey={refreshKey} />
        )}
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
            const ollamaHealthy =
              healthData?.ollama === 'connected' &&
              healthData.ollama_models.every(m => m.available)
            if (isActiveProviderReady(!!ollamaHealthy)) {
              setOllamaStatus('connected')
            }
          }}
          onClose={() => setApiKeyModalProvider(null)}
        />
      )}
    </div>
  )
}
