import { allLlmHeaders } from './llm'

export type GraphNodeType = 'paper' | 'author' | 'theme' | 'concept'
export type GraphEdgeType =
  | 'authored_by'
  | 'co_authored'
  | 'theme_of'
  | 'concept_of'
  | 'semantic'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  data: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type: GraphEdgeType
  weight: number
}

export interface GraphStats {
  nodes: Partial<Record<GraphNodeType, number>>
  edges: Partial<Record<GraphEdgeType, number>>
  node_total: number
  edge_total: number
}

export interface GraphData {
  version: number
  embed_model: string
  updated_at: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
  /**
   * Set by the backend when `graph.json` declares an unsupported schema
   * version. The UI surfaces a "Reconstruire" CTA instead of silently showing
   * an empty graph.
   */
  corrupt: boolean
  /**
   * Number of source files on disk with a sidecar. When this exceeds
   * `stats.nodes.paper`, the view fires a background `/graph/sync` to
   * back-fill papers imported before the graph feature shipped (or while
   * Ollama was unreachable).
   */
  source_count: number
  /**
   * Backend-side similarity threshold used when materialising semantic
   * edges. Surfaced so the frontend filter slider seeds from the same
   * source of truth — preventing drift between the rendered cutoff and
   * the edges actually stored on disk.
   */
  semantic_threshold: number
}

/**
 * SSE events emitted by `POST /graph/rebuild` and `POST /graph/sync`. The
 * shapes mirror what `app/graph/builder.py` writes so both ends drift
 * together via review rather than via runtime surprises.
 */
export interface GraphStartEvent {
  type: 'graph_start'
  total: number
}

export interface GraphResultEvent {
  type: 'graph_result'
  stem: string
  index: number
  total: number
  added: boolean
  reason: string
  concepts: number
  semantic_edges: number
}

export interface GraphDoneEvent {
  type: 'graph_done'
  total: number
  failed: number
  stats: Partial<GraphStats>
}

export interface GraphErrorEvent {
  type: 'graph_error'
  stem?: string
  error: string
}

export type GraphStreamEvent =
  | GraphStartEvent
  | GraphResultEvent
  | GraphDoneEvent
  | GraphErrorEvent

/**
 * Emitted by the per-source upload SSE stream (`POST /papers/upload/stream`)
 * after each indexed source. The frontend uses it to bump the graph
 * refresh key without waiting for the upload to finish.
 */
export interface GraphUpdatedEvent {
  type: 'graph_updated'
  filename: string
  stem: string
  added?: boolean
  concepts?: number
  semantic_edges?: number
}

export async function getGraph(projectId: string, signal?: AbortSignal): Promise<GraphData> {
  const res = await fetch(`/api/projects/${projectId}/graph`, {
    headers: allLlmHeaders(),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** POSTs an SSE endpoint and hands back the response body for streaming.
 * Throws on non-2xx or missing body — both indicate the caller has no stream
 * to drain or parse. Centralised so callers don't have to repeat the
 * `if (!res.ok) … if (!res.body) …` dance for every graph SSE endpoint. */
async function postSseStream(
  url: string,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: allLlmHeaders(),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('No response body')
  return res.body
}

export function rebuildGraph(
  projectId: string,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  return postSseStream(`/api/projects/${projectId}/graph/rebuild`, signal)
}

/**
 * Idempotent: ask the backend to add papers that exist on disk but aren't
 * yet in the graph. Fired automatically by GraphView on mount so legacy
 * sources get back-filled without manual intervention.
 */
export function syncGraph(
  projectId: string,
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  return postSseStream(`/api/projects/${projectId}/graph/sync`, signal)
}
