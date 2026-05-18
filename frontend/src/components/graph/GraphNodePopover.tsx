import { ExternalLink, Eye, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { GraphNode, GraphNodeType } from '../../api/graph'
import type { CanvasPosition } from './GraphCanvas'
import { cleanLabel } from './GraphCanvas.styles'
import styles from './GraphView.module.scss'

const TYPE_LABEL: Record<GraphNodeType, string> = {
  paper: 'Paper',
  author: 'Auteur',
  category: 'Catégorie',
  concept: 'Concept',
}

interface Props {
  node: GraphNode
  position: CanvasPosition
  /** `label` is the un-truncated paper title — the caller uses it to seed the
   * SourceList text search so the clicked source surfaces there too. */
  onOpenSource: (stem: string, label: string) => void
  onFilterSources: (filter: { author?: string; category?: string }) => void
  onClose: () => void
}

function _stemFromPaperId(id: string): string {
  return id.startsWith('paper:') ? id.slice('paper:'.length) : ''
}

/**
 * Compact card anchored above the clicked node. Carries only what should be
 * readable at a glance: type + label + the single primary action. Anything
 * verbose lives in the footer.
 *
 * Rendered through a portal into `document.body` with `position: fixed` so
 * the popover can extend past the canvas's `overflow: hidden` clip. The
 * coordinates received are viewport-relative (the canvas adds its own
 * bounding rect offset before emitting).
 */
export function GraphNodePopover({
  node,
  position,
  onOpenSource,
  onFilterSources,
  onClose,
}: Props) {
  const displayLabel = cleanLabel(node.label, node.type)
  return createPortal(
    <div
      className={styles.popover}
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-label={`Détails du nœud ${displayLabel}`}
    >
      <div className={styles.popoverHeader}>
        <span className={styles.infoBadge}>{TYPE_LABEL[node.type]}</span>
        <button
          type="button"
          className={styles.popoverClose}
          onClick={onClose}
          aria-label="Fermer"
          title="Fermer"
        >
          <X size={20} />
        </button>
      </div>
      <div className={styles.infoLabel}>{displayLabel}</div>
      <div className={styles.popoverActions}>
        {node.type === 'paper' && (
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              const stem = _stemFromPaperId(node.id)
              if (stem) onOpenSource(stem, node.label)
            }}
          >
            <ExternalLink size={18} /> Ouvrir
          </button>
        )}
        {node.type === 'author' && (
          <button
            type="button"
            className={styles.button}
            onClick={() => onFilterSources({ author: node.label })}
          >
            <Eye size={20} /> Voir les sources
          </button>
        )}
        {(node.type === 'category' || node.type === 'concept') && (
          <button
            type="button"
            className={styles.button}
            onClick={() => onFilterSources({ category: node.label })}
          >
            <Eye size={20} /> Voir les sources
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}
