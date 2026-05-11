import { describe, it, expect, beforeEach } from 'vitest'
import {
  allLlmHeaders,
  isActiveProviderReady,
  setStoredApiKey,
  setStoredProvider,
} from '../api/llm'

beforeEach(() => {
  localStorage.clear()
})

describe('isActiveProviderReady', () => {
  it('defers to ollama health when ollama is active', () => {
    setStoredProvider('ollama')
    expect(isActiveProviderReady(true)).toBe(true)
    expect(isActiveProviderReady(false)).toBe(false)
  })

  it('is true when an external provider has a stored key, regardless of ollama', () => {
    setStoredProvider('deepseek')
    setStoredApiKey('deepseek', 'sk-test')
    expect(isActiveProviderReady(false)).toBe(true)
    expect(isActiveProviderReady(true)).toBe(true)
  })

  it('is false when an external provider has no stored key', () => {
    setStoredProvider('openai')
    expect(isActiveProviderReady(true)).toBe(false)
  })
})

describe('allLlmHeaders', () => {
  it('returns empty when ollama is active and no custom URL', () => {
    setStoredProvider('ollama')
    expect(allLlmHeaders()).toEqual({})
  })

  it('includes X-Ollama-URL when set', () => {
    setStoredProvider('ollama')
    localStorage.setItem('ollamaBaseUrl', 'http://192.168.1.10:11434')
    expect(allLlmHeaders()).toEqual({ 'X-Ollama-URL': 'http://192.168.1.10:11434' })
  })

  it('includes X-LLM-Provider and X-LLM-API-Key for external providers', () => {
    setStoredProvider('gemini')
    setStoredApiKey('gemini', 'gem-key')
    expect(allLlmHeaders()).toEqual({
      'X-LLM-Provider': 'gemini',
      'X-LLM-API-Key': 'gem-key',
    })
  })

  it('omits API key header when provider is external but key is missing', () => {
    setStoredProvider('perplexity')
    expect(allLlmHeaders()).toEqual({ 'X-LLM-Provider': 'perplexity' })
  })
})
