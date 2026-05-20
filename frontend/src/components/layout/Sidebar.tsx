import { useState } from 'react'
import {
  ArrowLeftRight,
  Bug,
  Files,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Search,
  SlidersHorizontal,
  Target,
  Upload,
} from 'lucide-react'
import { type ProjectInfo } from '../../api/projects'
import { ProjectSwitcher } from './ProjectSwitcher'
import styles from './Sidebar.module.scss'

export const VIEWS = [
  'import',
  'sources',
  'problematique',
  'writing',
  'chat',
  'graph',
  'citations',
  'project-io',
  'settings',
  'debug',
  'new-project',
  'all-projects',
] as const

export type View = (typeof VIEWS)[number]

interface SidebarProps {
  activeView: View
  onViewChange: (view: View) => void
  projects: ProjectInfo[]
  currentProjectId: string | null
  onProjectSelect: (id: string) => void
  loading?: boolean
  /**
   * Hard-gate: when false, the Chat tab is not rendered. Chat needs Ollama
   * for the map step of /condense (and would also be inconsistent with the
   * hidden IA button in MetadataModal).
   */
  ollamaAvailable?: boolean
}

export function Sidebar({
  activeView,
  onViewChange,
  projects,
  currentProjectId,
  onProjectSelect,
  loading = false,
  ollamaAvailable = true,
}: SidebarProps) {
  const [pinned, setPinned] = useState(false)

  return (
    <nav className={`${styles.sidebar} ${pinned ? styles.pinned : ''}`}>
      <div className={styles.header}>
        <button
          className={styles.toggleBtn}
          onClick={() => setPinned((p) => !p)}
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
        loading={loading}
      />

      <div className={styles.top}>
        <button
          className={`${styles.tab} ${activeView === 'import' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('import')}
          aria-label="Import"
          title="Import"
        >
          <span className={styles.icon}>
            <Upload size={20} />
          </span>
          <span className={styles.label}>Import</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'sources' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('sources')}
          aria-label="Sources"
          title="Sources"
        >
          <span className={styles.icon}>
            <Files size={20} />
          </span>
          <span className={styles.label}>Sources</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'problematique' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('problematique')}
          aria-label="Problématique"
          title="Problématique & hypothèses"
        >
          <span className={styles.icon}>
            <Target size={20} />
          </span>
          <span className={styles.label}>Problématique</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'writing' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('writing')}
          aria-label="Rédaction"
          title="Aide à la rédaction"
        >
          <span className={styles.icon}>
            <PenLine size={20} />
          </span>
          <span className={styles.label}>Rédaction</span>
        </button>
        {ollamaAvailable && (
          <button
            className={`${styles.tab} ${activeView === 'chat' ? styles.tabActive : ''}`}
            onClick={() => onViewChange('chat')}
            aria-label="Chat"
            title="Chat avec un modèle"
          >
            <span className={styles.icon}>
              <MessageSquare size={20} />
            </span>
            <span className={styles.label}>Chat</span>
          </button>
        )}
        <button
          className={`${styles.tab} ${activeView === 'graph' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('graph')}
          aria-label="Graph"
          title="Graphe de connaissances"
        >
          <span className={styles.icon}>
            <Network size={20} />
          </span>
          <span className={styles.label}>Graph</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'citations' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('citations')}
          aria-label="Citations"
          title="Recherche par citations"
        >
          <span className={styles.icon}>
            <Search size={20} />
          </span>
          <span className={styles.label}>Citations</span>
        </button>
      </div>

      <div className={styles.bottom}>
        <button
          className={`${styles.tab} ${activeView === 'project-io' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('project-io')}
          aria-label="Export / Import"
          title="Exporter / importer un projet"
        >
          <span className={styles.icon}>
            <ArrowLeftRight size={20} />
          </span>
          <span className={styles.label}>Échange</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'settings' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('settings')}
          aria-label="Paramètres"
          title="Paramètres"
        >
          <span className={styles.icon}>
            <SlidersHorizontal size={20} />
          </span>
          <span className={styles.label}>Paramètres</span>
        </button>
        <button
          className={`${styles.tab} ${activeView === 'debug' ? styles.tabActive : ''}`}
          onClick={() => onViewChange('debug')}
          aria-label="Debug"
          title="ChromaDB debug"
        >
          <span className={styles.icon}>
            <Bug size={20} />
          </span>
          <span className={styles.label}>Debug</span>
        </button>
      </div>
    </nav>
  )
}
