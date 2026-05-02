import styles from './NoProjectState.module.scss'

interface NoProjectStateProps {
  onCreateProject: () => void
}

export function NoProjectState({ onCreateProject }: NoProjectStateProps) {
  return (
    <div className={styles.root}>
      <p className={styles.message}>No project selected.</p>
      <button className={styles.btnPrimary} onClick={onCreateProject}>
        Create your first project
      </button>
    </div>
  )
}
