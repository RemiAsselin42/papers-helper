import { useMemo } from 'react'
import type { HealthData } from '../api/health'
import { isActiveProviderReady, type LLMProvider } from '../api/llm'

export interface ProviderReadiness {
  /** True iff Ollama is connected and every required model is available. */
  ollamaHealthy: boolean
  /**
   * True iff the *active* provider (per the global getStoredProvider) is
   * usable: Ollama when ollamaHealthy, external providers when an API key is
   * stored. Recomputes when `activeProvider` changes so a provider switch
   * re-evaluates without callers having to bust their own memo.
   */
  providerReady: boolean
}

// `activeProvider` is intentionally part of the deps even though
// `isActiveProviderReady` reads the storage layer directly — the read happens
// on every render so a provider switch needs to invalidate this memo.
export function useProviderReadiness(
  healthData: HealthData | null,
  activeProvider: LLMProvider
): ProviderReadiness {
  return useMemo(() => {
    const ollamaHealthy =
      healthData?.ollama === 'connected' &&
      healthData.ollama_models.every((m) => m.available)
    return {
      ollamaHealthy: !!ollamaHealthy,
      providerReady: isActiveProviderReady(!!ollamaHealthy),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [healthData, activeProvider])
}
