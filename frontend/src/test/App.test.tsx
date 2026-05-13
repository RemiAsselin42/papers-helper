import { render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../App'

beforeAll(() => {
  // The App fires `listProjects()` (→ /api/projects/) and `checkHealth()`
  // (→ /api/health) on mount. The default mock returned `[]` for everything,
  // which crashes OllamaSetupModal because it reads `healthData.ollama_models.length`.
  // Branch on URL so the health probe sees a valid shape.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      const isHealth = url.includes('/health')
      return Promise.resolve({
        ok: true,
        json: async () =>
          isHealth
            ? {
                status: 'ok',
                ollama: 'connected',
                ollama_models: [],
                ollama_url: '',
                ollama_error: null,
                storage: 'accessible',
              }
            : [],
      })
    })
  )
})

describe('App', () => {
  it('renders the sidebar navigation once initial data resolves', async () => {
    render(<App />)
    // Wait for the post-mount fetches to settle before asserting. Without this,
    // React logs an `act()` warning about the state update from the Promise.all
    // resolution that races our synchronous assertions.
    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeInTheDocument()
    })
    expect(await screen.findByRole('button', { name: /import/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /sources/i })).toBeInTheDocument()
  })
})
