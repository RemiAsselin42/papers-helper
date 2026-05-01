import { useState } from 'react'
import { Upload, Files, Bug, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import styles from './Sidebar.module.scss'

export type Tab = 'import' | 'papers' | 'debug'

interface SidebarProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
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

      <div className={styles.top}>
        <button
          className={`${styles.tab} ${activeTab === 'import' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('import')}
          aria-label="Import"
          title="Import"
        >
          <span className={styles.icon}><Upload size={20} /></span>
          <span className={styles.label}>Import</span>
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'papers' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('papers')}
          aria-label="Papers"
          title="Papers"
        >
          <span className={styles.icon}><Files size={20} /></span>
          <span className={styles.label}>Papers</span>
        </button>
      </div>

      <div className={styles.bottom}>
        <button
          className={`${styles.tab} ${activeTab === 'debug' ? styles.tabActive : ''}`}
          onClick={() => onTabChange('debug')}
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
