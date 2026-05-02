import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderClosed, FolderOpen, Plus } from 'lucide-react'
import { type ProjectInfo } from '../api/projects'
import styles from './ProjectSwitcher.module.scss'

interface ProjectSwitcherProps {
  projects: ProjectInfo[]
  currentProjectId: string | null
  onSelect: (id: string) => void
  onShowNewProject: () => void
  onShowAllProjects: () => void
  newProjectActive?: boolean
  allProjectsActive?: boolean
}

export function ProjectSwitcher({
  projects,
  currentProjectId,
  onSelect,
  onShowNewProject,
  onShowAllProjects,
  newProjectActive,
  allProjectsActive,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null
  const otherProjects = projects.filter((p) => p.id !== currentProjectId)
  const hasOthers = otherProjects.length > 0

  // Projects sorted newest-first → oldest = ordinal 1
  const ordinal = (id: string) => projects.length - projects.findIndex((p) => p.id === id)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div ref={rootRef} className={styles.switcher}>
      {/* Current project — always visible */}
      <button
        className={styles.trigger}
        onClick={() => hasOthers && setOpen((o) => !o)}
        aria-label="Switch project"
        title={currentProject?.name ?? 'No project'}
        style={hasOthers ? undefined : { cursor: 'default' }}
      >
        <span className={styles.icon}>
          {currentProject ? (
            <span className={styles.ordinal}>{ordinal(currentProject.id)}</span>
          ) : (
            <span className={styles.ordinalEmpty}>
              <FolderClosed size={20} />
            </span>
          )}
        </span>
        <span className={styles.label}>
          {currentProject ? (
            currentProject.name
          ) : (
            <span className={styles.noProject}>No project</span>
          )}
        </span>
        {hasOthers && (
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>
            <ChevronDown size={20} />
          </span>
        )}
      </button>

      {/* Other projects — only when dropdown open */}
      {open && hasOthers && (
        <ul className={styles.list}>
          {otherProjects.map((p) => (
            <li key={p.id}>
              <button
                className={styles.projectBtn}
                onClick={() => {
                  onSelect(p.id)
                  setOpen(false)
                }}
              >
                <span className={styles.icon}>
                  <span className={styles.ordinal}>{ordinal(p.id)}</span>
                </span>
                <span className={styles.projectName}>{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* New project — always visible */}
      <button
        className={`${styles.newProjectBtn} ${newProjectActive ? styles.btnActive : ''}`}
        onClick={() => {
          setOpen(false)
          onShowNewProject()
        }}
      >
        <span className={styles.icon}>
          <Plus size={20} />
        </span>
        <span className={styles.btnLabel}>New project</span>
      </button>

      {/* All projects — always visible */}
      <button
        className={`${styles.allProjectsBtn} ${allProjectsActive ? styles.btnActive : ''}`}
        onClick={() => {
          setOpen(false)
          onShowAllProjects()
        }}
      >
        <span className={styles.icon}>
          <FolderOpen size={20} />
        </span>
        <span className={styles.btnLabel}>All projects</span>
      </button>
    </div>
  )
}
