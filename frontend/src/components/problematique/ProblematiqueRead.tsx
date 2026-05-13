import { Pencil } from 'lucide-react'
import type { Problematique } from '../../api/problematique'
import { Skeleton } from '../layout/Skeleton'
import styles from './ProblematiqueView.module.scss'

interface Props {
  data: Problematique | null
  onEdit: () => void
}

export function ProblematiqueRead({ data, onEdit }: Props) {
  const isEmpty =
    data !== null &&
    !data.research_problem &&
    !data.sub_research_problem &&
    data.hypotheses.length === 0 &&
    data.planned_approaches.length === 0 &&
    !data.expected_outcomes

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <h1 className={styles.title}>Problématique & hypothèses</h1>
        <button className={styles.btnSecondary} onClick={onEdit}>
          <Pencil size={16} />
          Modifier
        </button>
      </div>

      {data === null ? (
        <div className={styles.sections} aria-busy="true">
          <div className={styles.section}>
            <Skeleton width={180} height={12} />
            <div className={styles.skeletonSection}>
              <Skeleton height={14} />
              <Skeleton width="80%" height={14} />
            </div>
          </div>
          <div className={styles.section}>
            <Skeleton width={120} height={12} />
            <div className={styles.skeletonSection}>
              <Skeleton height={14} />
              <Skeleton width="70%" height={14} />
              <Skeleton width="55%" height={14} />
            </div>
          </div>
          <div className={styles.section}>
            <Skeleton width={150} height={12} />
            <div className={styles.skeletonSection}>
              <Skeleton height={14} />
              <Skeleton width="65%" height={14} />
            </div>
          </div>
        </div>
      ) : isEmpty ? (
        <p className={styles.emptyHint}>
          Aucune problématique définie.{' '}
          <button className={styles.inlineLink} onClick={onEdit}>
            Commencer maintenant
          </button>
        </p>
      ) : (
        <div className={styles.sections}>
          {(data.research_problem || data.sub_research_problem) && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Problème de recherche</p>
              {data.research_problem ? (
                <p className={styles.sectionText}>{data.research_problem}</p>
              ) : (
                <p className={styles.sectionMuted}>Non défini</p>
              )}
              {data.sub_research_problem && (
                <div className={styles.subSection}>
                  <p className={styles.subSectionLabel}>Sous-problématique</p>
                  <p className={styles.sectionText}>{data.sub_research_problem}</p>
                </div>
              )}
            </div>
          )}

          {data.hypotheses.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Hypothèses</p>
              <ol className={styles.readList}>
                {data.hypotheses.map((h, i) => (
                  <li key={i} className={styles.readListItem}>
                    {h.text ? (
                      <p className={styles.sectionText}>{h.text}</p>
                    ) : (
                      <p className={styles.sectionMuted}>Non définie</p>
                    )}
                    {h.sub_hypotheses.length > 0 && (
                      <ul className={styles.readSubList}>
                        {h.sub_hypotheses.map((s, j) => (
                          <li key={j} className={styles.readSubListItem}>
                            <p className={styles.sectionText}>{s}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {data.planned_approaches.length > 0 && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Approches planifiées</p>
              <div className={styles.readApproaches}>
                {data.planned_approaches.map((a, i) => (
                  <div key={i} className={styles.readApproach}>
                    <p className={styles.readApproachTitle}>
                      Approche {i + 1}
                      {a.title ? ` — ${a.title}` : ''}
                    </p>
                    {a.text ? (
                      <p className={styles.sectionText}>{a.text}</p>
                    ) : (
                      <p className={styles.sectionMuted}>Non définie</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.expected_outcomes && (
            <div className={styles.section}>
              <p className={styles.sectionLabel}>Résultats attendus</p>
              <p className={styles.sectionText}>{data.expected_outcomes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
