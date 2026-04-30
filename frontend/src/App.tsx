import { BookOpen } from 'lucide-react'
import styles from './App.module.scss'

export default function App() {
  return (
    <div className={styles.root}>
      <div className={styles.center}>
        <BookOpen className={styles.icon} />
        <h1 className={styles.title}>Papers Helper</h1>
        <p className={styles.subtitle}>Ton outil local de recherche académique</p>
      </div>
    </div>
  )
}
