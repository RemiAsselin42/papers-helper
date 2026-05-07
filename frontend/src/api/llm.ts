export type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini'

export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
}

export const DEFAULT_MODELS: Record<Exclude<LLMProvider, 'ollama'>, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.0-flash',
}

export const API_KEY_LINKS: Record<Exclude<LLMProvider, 'ollama'>, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey',
}

const PROVIDER_STORAGE_KEY = 'llmProvider'

export function getStoredProvider(): LLMProvider {
  return (localStorage.getItem(PROVIDER_STORAGE_KEY) as LLMProvider | null) ?? 'ollama'
}

export function setStoredProvider(p: LLMProvider): void {
  localStorage.setItem(PROVIDER_STORAGE_KEY, p)
}

export function getStoredApiKey(provider: Exclude<LLMProvider, 'ollama'>): string | null {
  return localStorage.getItem(`llmApiKey_${provider}`)
}

export function setStoredApiKey(
  provider: Exclude<LLMProvider, 'ollama'>,
  key: string | null,
): void {
  if (key) localStorage.setItem(`llmApiKey_${provider}`, key)
  else localStorage.removeItem(`llmApiKey_${provider}`)
}

export function getStoredExternalModel(provider: Exclude<LLMProvider, 'ollama'>): string {
  return localStorage.getItem(`llmModel_${provider}`) ?? DEFAULT_MODELS[provider]
}

export function setStoredExternalModel(
  provider: Exclude<LLMProvider, 'ollama'>,
  model: string,
): void {
  if (model) localStorage.setItem(`llmModel_${provider}`, model)
  else localStorage.removeItem(`llmModel_${provider}`)
}

export function llmHeaders(provider: LLMProvider): Record<string, string> {
  if (provider === 'ollama') return {}
  const key = getStoredApiKey(provider)
  return {
    'X-LLM-Provider': provider,
    ...(key ? { 'X-LLM-API-Key': key } : {}),
  }
}
