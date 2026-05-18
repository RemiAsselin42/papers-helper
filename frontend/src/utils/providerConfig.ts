import {
  PROVIDER_LABELS,
  getStoredApiKey,
  getStoredExternalModel,
  getStoredOllamaModel,
  getStoredProvider,
  type LLMProvider,
} from '../api/llm'

export interface ProviderReadiness {
  ok: boolean
  /** French, ready to display. Undefined when ok === true. */
  reason?: string
  provider: LLMProvider
  /** Resolved model to pass to streamCondense. Empty string if !ok. */
  model: string
}

/**
 * Returns whether the currently configured LLM provider can run an IA
 * generation (abstract, categories, condense). The /condense endpoint needs
 * Ollama for the map step regardless of the chosen provider — so we always
 * hard-gate on `ollamaHealthy` first.
 *
 * Mirrors the gating logic spread across MetadataModal.handleGenerateAbstract
 * and handleGenerateCategories so a single source of truth covers both the
 * manual flow and the auto-enrichment queue.
 */
export function canRunIA(ollamaHealthy: boolean): ProviderReadiness {
  const provider = getStoredProvider()

  if (!ollamaHealthy) {
    return {
      ok: false,
      reason: "Ollama n'est pas disponible — requis pour la génération IA.",
      provider,
      model: '',
    }
  }

  if (provider === 'ollama') {
    const stored = getStoredOllamaModel()
    if (!stored) {
      return {
        ok: false,
        reason: 'Aucun modèle Ollama sélectionné.',
        provider,
        model: '',
      }
    }
    return { ok: true, provider, model: stored }
  }

  if (!getStoredApiKey(provider)) {
    return {
      ok: false,
      reason: `Clé API manquante pour ${PROVIDER_LABELS[provider]}.`,
      provider,
      model: '',
    }
  }

  const model = getStoredExternalModel(provider)
  if (!model) {
    return {
      ok: false,
      reason: `Aucun modèle sélectionné pour ${PROVIDER_LABELS[provider]}.`,
      provider,
      model: '',
    }
  }

  return { ok: true, provider, model }
}
