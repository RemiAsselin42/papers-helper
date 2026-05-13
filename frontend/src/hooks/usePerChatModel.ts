import { useCallback, useMemo, useState } from 'react'
import {
  getStoredExternalModel,
  getStoredOllamaModel,
  type LLMProvider,
} from '../api/llm'

// Backend default — must match OLLAMA_GENERATION_MODEL in app/config.py.
export const OLLAMA_FALLBACK_MODEL = 'llama3'

type ExternalModelOverrides = Partial<Record<Exclude<LLMProvider, 'ollama'>, string>>

export interface UsePerChatModel {
  provider: LLMProvider
  ollamaModel: string | null
  /** Effective model string the chat will send — falls back to stored / default. */
  resolvedModel: string
  /** Reset to a fresh chat (re-seed from stored Ollama model). */
  reset: (provider: LLMProvider) => void
  /** Seed from a loaded conversation (provider + model only). */
  loadFromConversation: (conv: { provider: LLMProvider; model: string }) => void
  /** Used by the ModelSelector. */
  handleChange: (provider: LLMProvider, ollamaModel: string | null) => void
}

// Per-chat provider/model. Independent of localStorage — only affects the
// active conversation. New chats seed from the header (`defaultProvider` +
// stored defaults); loaded conversations seed from their persisted values.
export function usePerChatModel(defaultProvider: LLMProvider): UsePerChatModel {
  const [provider, setProvider] = useState<LLMProvider>(defaultProvider)
  const [ollamaModel, setOllamaModel] = useState<string | null>(() => getStoredOllamaModel())
  const [externalModel, setExternalModel] = useState<ExternalModelOverrides>({})

  const resolvedModel = useMemo(() => {
    if (provider === 'ollama') return ollamaModel ?? OLLAMA_FALLBACK_MODEL
    return externalModel[provider] ?? getStoredExternalModel(provider)
  }, [provider, ollamaModel, externalModel])

  const reset = useCallback((p: LLMProvider) => {
    setProvider(p)
    setOllamaModel(getStoredOllamaModel())
    setExternalModel({})
  }, [])

  const loadFromConversation = useCallback(
    (conv: { provider: LLMProvider; model: string }) => {
      setProvider(conv.provider)
      if (conv.provider === 'ollama') {
        setOllamaModel(conv.model)
      } else {
        setExternalModel((prev) => ({ ...prev, [conv.provider]: conv.model }))
      }
    },
    []
  )

  const handleChange = useCallback((p: LLMProvider, ollama: string | null) => {
    setProvider(p)
    if (p === 'ollama') setOllamaModel(ollama)
  }, [])

  return { provider, ollamaModel, resolvedModel, reset, loadFromConversation, handleChange }
}
