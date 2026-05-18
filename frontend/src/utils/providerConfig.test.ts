import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { canRunIA } from './providerConfig'

function setProvider(p: string) {
  localStorage.setItem('llmProvider', p)
}

describe('canRunIA', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('blocks when Ollama is unhealthy regardless of provider', () => {
    setProvider('anthropic')
    localStorage.setItem('llmApiKey_anthropic', 'sk-test')
    const r = canRunIA(false)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Ollama/i)
  })

  it('requires an Ollama model when provider is ollama', () => {
    setProvider('ollama')
    const r = canRunIA(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/modèle Ollama/i)
  })

  it('passes when provider is ollama and a model is selected', () => {
    setProvider('ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    const r = canRunIA(true)
    expect(r.ok).toBe(true)
    expect(r.model).toBe('llama3')
    expect(r.provider).toBe('ollama')
  })

  it('requires an API key when provider is external', () => {
    setProvider('anthropic')
    const r = canRunIA(true)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/Clé API/i)
  })

  it('falls back to the default model when none is explicitly stored', () => {
    setProvider('anthropic')
    localStorage.setItem('llmApiKey_anthropic', 'sk-test')
    const r = canRunIA(true)
    expect(r.ok).toBe(true)
    // getStoredExternalModel returns DEFAULT_MODELS.anthropic when nothing is set
    expect(r.model).toBeTruthy()
    expect(r.provider).toBe('anthropic')
  })
})
