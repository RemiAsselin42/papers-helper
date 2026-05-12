export type LLMProvider =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'perplexity'
  | 'deepseek'

export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
}

export const DEFAULT_MODELS: Record<Exclude<LLMProvider, 'ollama'>, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.0-flash',
  perplexity: 'sonar',
  deepseek: 'deepseek-chat',
}

export const API_KEY_LINKS: Record<Exclude<LLMProvider, 'ollama'>, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  perplexity: 'https://www.perplexity.ai/settings/api',
  deepseek: 'https://platform.deepseek.com/api_keys',
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

const OLLAMA_MODEL_STORAGE_KEY = 'ollamaModel'

export function getStoredOllamaModel(): string | null {
  return localStorage.getItem(OLLAMA_MODEL_STORAGE_KEY)
}

export function setStoredOllamaModel(model: string | null): void {
  if (model) localStorage.setItem(OLLAMA_MODEL_STORAGE_KEY, model)
  else localStorage.removeItem(OLLAMA_MODEL_STORAGE_KEY)
}

const PLAIN_TEXT_STORAGE_KEY = 'chatPlainText'

export function getStoredPlainText(): boolean {
  return localStorage.getItem(PLAIN_TEXT_STORAGE_KEY) === '1'
}

export function setStoredPlainText(enabled: boolean): void {
  if (enabled) localStorage.setItem(PLAIN_TEXT_STORAGE_KEY, '1')
  else localStorage.removeItem(PLAIN_TEXT_STORAGE_KEY)
}

export function plainTextHeader(): Record<string, string> {
  return getStoredPlainText() ? { 'X-Prefer-Plain-Text': '1' } : {}
}

export function llmHeaders(provider: LLMProvider): Record<string, string> {
  if (provider === 'ollama') return {}
  const key = getStoredApiKey(provider)
  return {
    'X-LLM-Provider': provider,
    ...(key ? { 'X-LLM-API-Key': key } : {}),
  }
}

export function allLlmHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  // Inline read to avoid a circular import with ./health.
  const ollamaUrl = localStorage.getItem('ollamaBaseUrl')
  if (ollamaUrl) headers['X-Ollama-URL'] = ollamaUrl
  return { ...headers, ...llmHeaders(getStoredProvider()) }
}

export function isActiveProviderReady(ollamaHealthy: boolean): boolean {
  const provider = getStoredProvider()
  if (provider === 'ollama') return ollamaHealthy
  return !!getStoredApiKey(provider)
}
