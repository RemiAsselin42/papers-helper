import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetadataModal } from '../components/sources/MetadataModal'
import type { SourceInfo } from '../api/papers'

function makeSource(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    stem: 'paper-1',
    filename: 'paper-1.pdf',
    chunk_total: 4,
    pdf_title: 'Sample title',
    author: '',
    year: '',
    source_type: 'pdf',
    authors_json: '',
    publication: '',
    doi: '',
    abstract: '',
    notes: '',
    categories: '',
    indexed: true,
    index_error: '',
    ...overrides,
  }
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

function frame(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n`
}

function getIaButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /générer un résumé avec l’IA/i }) as HTMLButtonElement
}

function getAbstractTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Résumé ou description de la source') as HTMLTextAreaElement
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MetadataModal — handleGenerateAbstract', () => {
  it('refuses to generate when the source is not indexed', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource({ indexed: false })}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(getIaButton())
    expect(screen.getByText(/n'est pas indexée/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to generate when the active external provider has no API key', () => {
    localStorage.setItem('llmProvider', 'openai')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(getIaButton())
    expect(screen.getByText(/clé api manquante pour openai/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to generate when Ollama is selected but no model is stored', () => {
    localStorage.setItem('llmProvider', 'ollama')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(getIaButton())
    expect(screen.getByText(/aucun modèle ollama/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to generate when an external provider has a key but the stored model is empty', () => {
    localStorage.setItem('llmProvider', 'anthropic')
    localStorage.setItem('llmApiKey_anthropic', 'sk-test')
    // Empty string in storage overrides the default — getStoredExternalModel returns ''.
    localStorage.setItem('llmModel_anthropic', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(getIaButton())
    expect(screen.getByText(/aucun modèle sélectionné pour anthropic/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('streams tokens into the abstract textarea on the happy path', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([frame({ token: 'Hel' }), frame({ token: 'lo' }), 'data: [DONE]\n']),
      })
    )
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(getIaButton())
    })
    await waitFor(() => {
      expect(getAbstractTextarea().value).toBe('Hello')
    })
    // After completion, button reverts to "Générer" label.
    expect(getIaButton()).toBeInTheDocument()
  })

  it('hides the IA button entirely when ollamaAvailable is false', () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable={false}
      />
    )
    expect(
      screen.queryByRole('button', { name: /générer un résumé avec l’IA/i })
    ).toBeNull()
  })

  it('targets POST /api/projects/<id>/condense with prompt + stems + model body', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: sseStream(['data: [DONE]\n']),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="proj-42"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(getIaButton())
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-42/condense')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ stems: ['paper-1'], model: 'llama3' })
    expect(typeof body.prompt).toBe('string')
    expect(body.prompt.length).toBeGreaterThan(20)
    expect(init.headers['X-Ollama-Model']).toBe('llama3')
  })

  it('renders a progress panel with map counter while streaming', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: sseStream([
          frame({ progress: { phase: 'start', strategy: 'map_reduce_single' } }),
          frame({ progress: { phase: 'map', done: 3, total: 12 } }),
          frame({ progress: { phase: 'reduce' } }),
          frame({ token: 'ok' }),
          'data: [DONE]\n',
        ]),
      })
    )
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(getIaButton())
    })
    // Once the stream completes, the panel disappears (progress reset). The
    // panel renders mid-stream — to assert it we mount a stream that pauses.
    // Here we accept that the final state has no panel and instead verify
    // the textarea received the reduce token.
    await waitFor(() => expect(getAbstractTextarea().value).toBe('ok'))
  })

  it('shows progress panel mid-stream with phase + counter', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    let releaseStream: () => void = () => {}
    const streamPromise = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(
              encoder.encode(frame({ progress: { phase: 'start', strategy: 'map_reduce_single' } }))
            )
            controller.enqueue(
              encoder.encode(frame({ progress: { phase: 'map', done: 7, total: 24 } }))
            )
            await streamPromise
            controller.enqueue(encoder.encode('data: [DONE]\n'))
            controller.close()
          },
        }),
      })
    )
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(getIaButton())
    })
    await waitFor(() => {
      expect(screen.getByLabelText(/avancement de la génération/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/chunk 7\s*\/\s*24/i)).toBeInTheDocument()
    // Release the stream so the modal teardown is clean.
    await act(async () => {
      releaseStream()
    })
  })

  it('seeds the categories pill list from source.categories', () => {
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource({ categories: 'Sociologie, Méthodes' })}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    expect(screen.getByText('Sociologie')).toBeInTheDocument()
    expect(screen.getByText('Méthodes')).toBeInTheDocument()
  })

  it('opens a popover on "+ Ajouter" and commits a category on Enter', () => {
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /ajouter une catégorie/i }))
    const input = screen.getByPlaceholderText('Nom de la catégorie') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Nouveau' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Nouveau')).toBeInTheDocument()
    // Popover should close after commit.
    expect(screen.queryByPlaceholderText('Nom de la catégorie')).toBeNull()
  })

  it('removes a category when its × button is clicked', () => {
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource({ categories: 'Sociologie' })}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /supprimer la catégorie sociologie/i }))
    expect(screen.queryByText('Sociologie')).toBeNull()
  })

  it('IA categories: derives categories from the abstract via /categorize and dedups', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    // /categorize is a plain JSON endpoint — the LLM output is returned as
    // { text } and parsed client-side.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: '["Sociologie", "Méthodes", "sociologie"]' }),
      })
    )
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource({ categories: 'Sociologie', abstract: 'un résumé du document' })}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /générer des catégories avec l’IA/i })
      )
    })
    // "Sociologie" already there, "sociologie" merges into it, "Méthodes" is added.
    await waitFor(() => {
      expect(screen.getByText('Méthodes')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/sociologie/i).length).toBe(1)
  })

  it('IA categories: refuses to run when no abstract is available yet', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /générer des catégories avec l’IA/i })
      )
    })
    expect(screen.getByText(/d'abord un résumé/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('IA categories: surfaces an error message when the response has no parseable array', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: 'pas un tableau' }),
      })
    )
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource({ abstract: 'un résumé du document' })}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /générer des catégories avec l’IA/i })
      )
    })
    await waitFor(() => {
      expect(screen.getByText(/réponse ia inexploitable/i)).toBeInTheDocument()
    })
  })

  it('clicking IA while streaming aborts the in-flight request', async () => {
    localStorage.setItem('llmProvider', 'ollama')
    localStorage.setItem('ollamaModel', 'llama3')
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <MetadataModal
        projectId="p1"
        source={makeSource()}
        onSave={() => {}}
        onClose={() => {}}
        ollamaAvailable
      />
    )
    // First click — kicks off generation.
    await act(async () => {
      fireEvent.click(getIaButton())
    })
    // While streaming the button is labelled "Annuler".
    const cancelBtn = await screen.findByRole('button', {
      name: /annuler la génération du résumé/i,
    })
    // Second click — aborts.
    await act(async () => {
      fireEvent.click(cancelBtn)
    })
    // Back to the idle label; no error surfaced (AbortError is swallowed).
    await waitFor(() => {
      expect(getIaButton()).toBeInTheDocument()
    })
    expect(screen.queryByText(/erreur de génération/i)).toBeNull()
  })
})
