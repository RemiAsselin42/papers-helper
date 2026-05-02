import { useState } from 'react'
import { Bug, Files, PanelLeftClose, PanelLeftOpen, Upload } from 'lucide-react'
import { type ProjectInfo } from '../api/projects'
import { ProjectSwitcher } from './ProjectSwitcher'
import styles from './Sidebar.module.scss'

export type View = 'import' | 'papers' | 'debug' | 'new-project' | 'all-projects'

interface SidebarProps {
  activeView: View
  onViewChange: (view: View) => void
  projects: ProjectInfo[]
  currentProjectId: string | null
  onProjectSelect: (id: string) => void
}

export function Sidebar({
  activeView,
  onViewChange,
  projects,
  currentProjectId,
  onProjectSelect,
}: SidebarProps) {
  const [pinned, setPinned] = useState(false)

  return (
    <nav className={`${styles.sidebar} ${pinned ? styles.pinned : ''}`}>
      <div className={styles.header}>
        <button
          className={styles.toggleBtn}
          onClick={() => setPinned(p => !p)}
          aria-label={pinned ? 'Réduire la barre latérale' : 'Épingler la barre latérale'}
          title={pinned ? 'Réduire' : 'Épingler'}
        >
          <span className={styles.icon}>
            {pinned ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
          </span>
        </button>
      </div>

      <ProjectSwitcher
        projects={projects}
        currentProjectId={currentProjectId}
        onSelect={onProjectSelect}
        onShowNewProject={() => onViewChange('new-project')}
        onShowAllProjects={() => onViewChange('all-projects')}
        newProjectActive={activeView === 'new-project'}
        allProjectsActive={activeView === 'all-projects'}
      />

      <div className={styles.top}>
        <button
          className={`${styles.tab} ${activeView === 'import' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('import')}
          aria-label="Import"
          title="Import"
        >
          <span className={styles.icon}><Upload size={20} /></span>
          <span className={styles.label}>Import</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'papers' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('papers')}
          aria-label="Papers"
          title="Papers"
        >
          <span className={styles.icon}><Files size={20} /></span>
          <span className={styles.label}>Papers</span>
        </button>
      </div>

      <div className={styles.bottom}>
        <button
          className={`${styles.tab} ${activeView === 'debug' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('debug')}
          aria-label="Debug"
          title="ChromaDB debug"
        >
          <span className={styles.icon}><Bug size={20} /></span>
          <span className={styles.label}>Debug</span>
        </button>
      </div>
    </nav>
  )
}
