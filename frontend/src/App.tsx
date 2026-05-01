import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import styles from './App.module.scss'
import { Sidebar, type Tab } from './components/Sidebar'
import { DropZone, type FileState } from './components/DropZone'
import { PaperList } from './components/PaperList'
import { DebugPanel } from './components/DebugPanel'
import { ImportProgressToast } from './components/ImportProgressToast'

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('import')
  const [refreshKey, setRefreshKey] = useState(0)
  const [importStates, setImportStates] = useState<FileState[]>([])
  const bump = () => setRefreshKey(k => k + 1)

  return (
    <div className={styles.root}>
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} />
      <main className={styles.content}>
        {activeTab === 'import' && (
          <div className={styles.importSection}>
            <div className={styles.importHeader}>
              <BookOpen className={styles.importIcon} />
              <h1 className={styles.importTitle}>Papers Helper</h1>
              <p className={styles.importSubtitle}>Ton outil local de recherche académique</p>
            </div>
            <DropZone onSuccess={bump} onProgress={setImportStates} />
          </div>
        )}
        {activeTab === 'papers' && <PaperList refreshKey={refreshKey} onDelete={bump} />}
        {activeTab === 'debug'  && <DebugPanel refreshKey={refreshKey} />}
      </main>
      <ImportProgressToast
        fileStates={importStates}
        onDismiss={() => setImportStates([])}
      />
    </div>
  )
}
