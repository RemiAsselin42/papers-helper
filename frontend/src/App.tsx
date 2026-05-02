import { BookOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import styles from './App.module.scss'
import { listProjects, type ProjectInfo } from './api/projects'
import { AllProjectsView } from './components/AllProjectsView'
import { DebugPanel } from './components/DebugPanel'
import { DropZone, type FileState } from './components/DropZone'
import { ImportProgressToast } from './components/ImportProgressToast'
import { NewProjectView } from './components/NewProjectView'
import { NoProjectState } from './components/NoProjectState'
import { PaperList } from './components/PaperList'
import { Sidebar, type View } from './components/Sidebar'

const STORAGE_KEY = 'currentProjectId'

export default function App() {
  const [activeView, setActiveView] = useState<View>('import')
  const [refreshKey, setRefreshKey] = useState(0)
  const [importStates, setImportStates] = useState<FileState[]>([])

  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [projectsLoaded, setProjectsLoaded] = useState(false)

  const bump = () => setRefreshKey(k => k + 1)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    listProjects()
      .then(list => {
        setProjects(list)
        if (stored && list.some(p => p.id === stored)) {
          setCurrentProjectId(stored)
        }
      })
      .catch(console.error)
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

  if (!projectsLoaded) {
    return (
      <div className={styles.root}>
        {sidebar}
        <main className={styles.content} />
      </div>
    )
  }

  function renderMain() {
    // 'new-project' est toujours accessible
    if (activeView === 'new-project') {
      return <NewProjectView onCreated={handleProjectCreated} />
    }
    // Toutes les autres vues nécessitent au moins un projet
    if (projects.length === 0 || currentProjectId === null) {
      return <NoProjectState onCreateProject={() => setActiveView('new-project')} />
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
    return (
      <>
        {activeView === 'import' && (
          <div className={styles.importSection}>
            <div className={styles.importHeader}>
              <BookOpen className={styles.importIcon} />
              <h1 className={styles.importTitle}>Papers Helper</h1>
              <p className={styles.importSubtitle}>Ton outil local de recherche académique</p>
            </div>
            <DropZone projectId={currentProjectId} onSuccess={bump} onProgress={setImportStates} />
          </div>
        )}
        {activeView === 'papers' && (
          <PaperList projectId={currentProjectId} refreshKey={refreshKey} onDelete={bump} />
        )}
        {activeView === 'debug' && (
          <DebugPanel projectId={currentProjectId} refreshKey={refreshKey} />
        )}
      </>
    )
  }

  return (
    <div className={styles.root}>
      {sidebar}
      <main className={styles.content}>
        {renderMain()}
      </main>
      <ImportProgressToast fileStates={importStates} onDismiss={() => setImportStates([])} />
    </div>
  )
}
