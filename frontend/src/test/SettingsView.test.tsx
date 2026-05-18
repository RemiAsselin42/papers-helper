import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../components/settings/SettingsView'
import type { ProjectSettingsBundle } from '../api/settings'

const BUNDLE: ProjectSettingsBundle = {
  overrides: { embed_model: null, chunk_granularity: null, auto_enrich: null },
  global_defaults: {
    embed_model: 'nomic-embed-text',
    chunk_granularity: 'equilibre',
    auto_enrich: true,
  },
  resolved: {
    embed_model: 'nomic-embed-text',
    chunk_granularity: 'equilibre',
    max_chunk_chars: 2000,
    auto_enrich: true,
  },
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url)
    if (u.includes('/models')) return json(['nomic-embed-text', 'bge-m3'])
    if (u.includes('/settings')) return json(BUNDLE)
    return json({})
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsView', () => {
  it('renders the global, project and effective cards once loaded', async () => {
    render(<SettingsView projectId="p1" />)

    await waitFor(() => {
      expect(screen.getByText('Défauts globaux')).toBeInTheDocument()
    })
    expect(screen.getByText('Surcharges du projet courant')).toBeInTheDocument()
    expect(screen.getByText(/Valeurs effectives/)).toBeInTheDocument()
  })

  it('offers a "Par défaut" inherit option in the per-project overrides', async () => {
    render(<SettingsView projectId="p1" />)

    await waitFor(() => {
      expect(screen.getByText('Surcharges du projet courant')).toBeInTheDocument()
    })
    // One "Par défaut (…)" option per overridable field (model, granularity, IA).
    expect(screen.getAllByText(/Par défaut/).length).toBeGreaterThanOrEqual(3)
  })

  it('lists pulled Ollama models as embedding-model options', async () => {
    render(<SettingsView projectId="p1" />)

    await waitFor(() => {
      expect(screen.getAllByText('bge-m3').length).toBeGreaterThan(0)
    })
  })

  it('reveals the `ollama pull` model guide when the help button is clicked', async () => {
    render(<SettingsView projectId="p1" />)

    await waitFor(() => {
      expect(screen.getByText('Défauts globaux')).toBeInTheDocument()
    })
    expect(screen.queryByText(/ollama pull bge-m3/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /ajouter un modèle d’embedding/i }))
    expect(screen.getByText(/ollama pull bge-m3/)).toBeInTheDocument()
    expect(screen.getByText(/ollama pull nomic-embed-text/)).toBeInTheDocument()
  })
})
