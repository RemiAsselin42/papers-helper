import type { GraphEdge, GraphNode, GraphNodeType } from '../../api/graph'
import { cleanLabel, formatCslName } from './GraphCanvas.styles'
import styles from './GraphView.module.scss'

/** Render a single `node.data` value. Strings pass through; CSL author
 * records (`{family, given}`) become "Nom, Prénom"; arrays are formatted
 * item-by-item; everything else falls back to JSON. */
function _formatDataValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(_formatDataValue).join(', ')
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    return formatCslName(value) ?? JSON.stringify(value)
  }
  return String(value)
}

const TYPE_LABEL: Record<GraphNodeType, string> = {
  paper: 'Paper',
  author: 'Auteur',
  theme: 'Thème',
  concept: 'Concept',
}

interface NeighborSummary {
  id: string
  label: string
  type: GraphNodeType
}

interface Props {
  node: GraphNode
  neighbors: NeighborSummary[]
  paperIdToLabel: Map<string, string>
  semanticEdges: GraphEdge[]
  onPickNode: (nodeId: string) => void
}

/**
 * Overlay anchored to the bottom of the canvas. Carries the secondary
 * information that doesn't fit in the popover: per-type data fields, semantic
 * neighbours for papers, and the generic neighbour list for everything else.
 */
export function GraphNodeFooter({
  node,
  neighbors,
  paperIdToLabel,
  semanticEdges,
  onPickNode,
}: Props) {
  const dataEntries = Object.entries(node.data).filter(
    ([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
  )

  const semanticNeighbors =
    node.type === 'paper'
      ? semanticEdges
          .filter((e) => e.source === node.id || e.target === node.id)
          .map((e) => {
            const otherId = e.source === node.id ? e.target : e.source
            const raw = paperIdToLabel.get(otherId) ?? otherId
            return {
              id: otherId,
              label: cleanLabel(raw, 'paper'),
              weight: e.weight,
            }
          })
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 8)
      : []

  const hasAnything =
    dataEntries.length > 0 || semanticNeighbors.length > 0 || neighbors.length > 0
  if (!hasAnything) return null

  return (
    <div className={styles.footer}>
      {dataEntries.length > 0 && (
        <dl className={styles.infoData}>
          {dataEntries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{_formatDataValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {semanticNeighbors.length > 0 && (
        <div className={styles.neighbors}>
          <strong>Similaires :</strong>
          <ul>
            {semanticNeighbors.map((n) => (
              <li key={n.id} onClick={() => onPickNode(n.id)}>
                {n.label}{' '}
                <span className={styles.infoMeta}>({n.weight.toFixed(2)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {neighbors.length > 0 && (
        <div className={styles.neighbors}>
          <strong>Voisins :</strong>
          <ul>
            {neighbors.slice(0, 10).map((n) => (
              <li key={n.id} onClick={() => onPickNode(n.id)}>
                {cleanLabel(n.label, n.type)}{' '}
                <span className={styles.infoMeta}>({TYPE_LABEL[n.type]})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
