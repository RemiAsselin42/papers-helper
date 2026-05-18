import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeGenerateStream,
  createDoc,
  deleteDoc,
  listDocs,
  renameDoc,
  saveDoc,
  type WritingDoc,
} from '../api/writing'
import { WritingView } from '../components/writing/WritingView'

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) })
}

function sseResponse(frames: string[]) {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return Promise.resolve({ ok: true, status: 200, body })
}

function doc(id: string, title: string, content = ''): WritingDoc {
  return {
    id,
    title,
    content_html: content,
    citations: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  }
}

const _GEN_FRAMES = ['data: {"token":"Passage genere."}\n\n', 'data: [DONE]\n\n']

const _HIT = {
  chunk_id: 'paper-a::0',
  text: 'Les réseaux de neurones apprennent des représentations.',
  chunk_index: 0,
  chunk_total: 1,
  similarity: 0.9,
  stem: 'paper-a',
  filename: 'paper-a.pdf',
  title: 'Paper A',
  author: 'Smith, J.',
  year: '2024',
}

/** Routes a stubbed fetch by URL + method against an in-memory document list. */
function routedFetch(opts: { docs?: WritingDoc[]; newId?: string; hits?: unknown[] } = {}) {
  const docs = opts.docs ?? []
  return vi.fn((url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/generate')) return sseResponse(_GEN_FRAMES)
    if (u.includes('/citations/search')) {
      return jsonResponse({ query: 'q', results: opts.hits ?? [] })
    }
    if (u.endsWith('/writing/')) {
      if (method === 'POST') return jsonResponse(doc(opts.newId ?? 'new-1', 'Nouveau texte'), 201)
      return jsonResponse(docs.map((d) => ({ id: d.id, title: d.title, created_at: d.created_at, updated_at: d.updated_at })))
    }
    if (method === 'DELETE') return Promise.resolve({ ok: true, status: 204 })
    if (method === 'PUT' || method === 'PATCH') {
      return jsonResponse(JSON.parse(String(init?.body ?? '{}')))
    }
    const id = u.split('/').pop()
    return jsonResponse(docs.find((d) => d.id === id) ?? doc(id ?? 'x', 'Inconnu'))
  })
}

describe('writing API client', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('listDocs GETs the writing collection', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Texte 1')] }))
    const list = await listDocs('p1')
    expect(list[0].id).toBe('d1')
  })

  it('createDoc POSTs to the collection', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    const created = await createDoc('p1')
    expect(created.id).toBe('new-1')
    const [url, init] = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/writing/')
    ) as unknown as [string, RequestInit]
    expect(url).toBe('/api/projects/p1/writing/')
    expect(init.method).toBe('POST')
  })

  it('saveDoc PUTs the document body', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    await saveDoc('p1', 'd1', { title: 'T', content_html: '<p>x</p>', citations: [] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/projects/p1/writing/d1')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string).content_html).toBe('<p>x</p>')
  })

  it('renameDoc PATCHes the title', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    await renameDoc('p1', 'd1', 'Nouveau nom')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string).title).toBe('Nouveau nom')
  })

  it('deleteDoc DELETEs the document', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    await deleteDoc('p1', 'd1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/projects/p1/writing/d1')
    expect(init.method).toBe('DELETE')
  })
})

describe('consumeGenerateStream', () => {
  it('forwards every {token} payload and stops at [DONE]', async () => {
    const { body } = await sseResponse([
      'data: {"token":"Bonjour "}\n\n',
      'data: {"token":"le monde."}\n\n',
      'data: [DONE]\n\n',
    ])
    const tokens: string[] = []
    await consumeGenerateStream(body!, (t) => tokens.push(t))
    expect(tokens.join('')).toBe('Bonjour le monde.')
  })

  it('throws on a backend {error} event', async () => {
    const { body } = await sseResponse(['data: {"error":"Ollama down"}\n\n', 'data: [DONE]\n\n'])
    await expect(consumeGenerateStream(body!, () => {})).rejects.toThrow('Ollama down')
  })
})

describe('WritingView', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    localStorage.setItem('ollamaModel', 'llama3')
  })

  it('loads the most recent document into the title editor', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Mon premier texte', '<p>hi</p>')] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    const title = (await screen.findByLabelText('Nom du texte')) as HTMLInputElement
    expect(title.value).toBe('Mon premier texte')
  })

  it('shows the empty state when the project has no documents', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    expect(await screen.findByText('Aucun texte pour ce projet.')).toBeInTheDocument()
  })

  it('creates a document from the empty state', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [], newId: 'created-1' }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByText('Aucun texte pour ce projet.')

    // Two "Nouveau texte" buttons exist (the doc-list panel + the empty
    // state); both trigger creation — click the first.
    fireEvent.click(screen.getAllByRole('button', { name: /nouveau texte/i })[0])

    const title = (await screen.findByLabelText('Nom du texte')) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe('Nouveau texte'))
  })

  it('selects another document from the list', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ docs: [doc('d1', 'Texte un'), doc('d2', 'Texte deux')] })
    )
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByLabelText('Nom du texte')

    fireEvent.click(screen.getByText('Texte deux'))

    const title = (await screen.findByLabelText('Nom du texte')) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe('Texte deux'))
  })

  it('streams a generated passage and closes the panel on insert', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Texte')] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByLabelText('Nom du texte')

    fireEvent.click(screen.getByRole('button', { name: /générer/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /générer/i })[1])

    const insert = await screen.findByRole('button', { name: /insérer au curseur/i })
    fireEvent.click(insert)

    await waitFor(() =>
      expect(screen.queryByLabelText('Consignes de génération')).not.toBeInTheDocument()
    )
  })

  it('inserts a picked citation, lists it, and removes it manually', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Texte')], hits: [_HIT] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByLabelText('Nom du texte')

    fireEvent.click(screen.getByRole('button', { name: /citer/i }))
    expect(await screen.findByRole('dialog', { name: /insérer une citation/i })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Rechercher une citation'), {
      target: { value: 'neural' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    fireEvent.click(await screen.findByText(/Smith, J\. \(2024\)\. Paper A\./i))

    // The references dropdown appears collapsed — expand it to reveal the list.
    const refsToggle = await screen.findByRole('button', { name: /références citées/i })
    fireEvent.click(refsToggle)

    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence/i }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /références citées/i })).not.toBeInTheDocument()
    )
  })

  it('exposes a formatting toolbar that toggles bold', async () => {
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Texte')] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByLabelText('Nom du texte')

    const bold = screen.getByRole('button', { name: /gras/i })
    expect(bold).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(bold)
    await waitFor(() => expect(bold).toHaveAttribute('aria-pressed', 'true'))
  })

  it('counts a source cited from several passages as a single reference', async () => {
    const hit2 = { ..._HIT, chunk_id: 'paper-a::1', chunk_index: 1 }
    vi.stubGlobal('fetch', routedFetch({ docs: [doc('d1', 'Texte')], hits: [_HIT, hit2] }))
    render(<WritingView projectId="p1" ollamaAvailable />)
    await screen.findByLabelText('Nom du texte')

    async function pickNth(n: number) {
      fireEvent.click(screen.getByRole('button', { name: /citer/i }))
      fireEvent.change(screen.getByLabelText('Rechercher une citation'), {
        target: { value: 'neural' },
      })
      fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))
      fireEvent.click((await screen.findAllByText(/Smith, J\. \(2024\)\. Paper A\./i))[n])
    }

    await pickNth(0)
    await pickNth(1)

    // Two passages of the same source → one bibliography entry.
    const toggle = await screen.findByRole('button', { name: /références citées \(1\)/i })
    fireEvent.click(toggle)
    expect(screen.getAllByRole('button', { name: /supprimer la référence/i })).toHaveLength(1)
  })
})
