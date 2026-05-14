import { useCallback, useEffect, useState } from 'react'
import { getGraph, type GraphData } from '../api/graph'

interface UseGraphState {
  graph: GraphData | null
  loading: boolean
  error: string | null
}

/**
 * Fetches `/api/projects/{id}/graph` and re-fetches whenever *refreshKey*
 * bumps. The parent (App.tsx) bumps it when ingestion SSE emits a
 * `graph_updated` event, so the view stays in sync without a dedicated
 * websocket.
 */
export function useGraph(
  projectId: string | null,
  refreshKey: number
): UseGraphState & { refresh: () => void } {
  const [state, setState] = useState<UseGraphState>({
    graph: null,
    loading: false,
    error: null,
  })
  const [localRefresh, setLocalRefresh] = useState(0)

  const refresh = useCallback(() => setLocalRefresh((n) => n + 1), [])

  useEffect(() => {
    if (!projectId) {
      setState({ graph: null, loading: false, error: null })
      return
    }
    const ctrl = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    getGraph(projectId, ctrl.signal)
      .then((graph) => {
        setState({ graph, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return
        const msg = err instanceof Error ? err.message : String(err)
        setState({ graph: null, loading: false, error: msg })
      })
    return () => ctrl.abort()
  }, [projectId, refreshKey, localRefresh])

  return { ...state, refresh }
}
