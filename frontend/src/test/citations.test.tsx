import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCitationContext, searchCitations, type CitationHit } from '../api/citations'
import { CitationsView } from '../components/citations/CitationsView'
import { formatReference } from '../components/citations/citationReference'

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const HIT: CitationHit = {
  chunk_id: 'paper-a::0',
  text: 'Les réseaux de neurones convolutifs apprennent des représentations.',
  chunk_index: 0,
  chunk_total: 3,
  similarity: 0.91,
  stem: 'paper-a',
  filename: 'paper-a.pdf',
  title: 'Paper A',
  author: 'Smith, J.',
  year: '2024',
}

describe('searchCitations', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('POSTs the query + filters and returns the results array', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ query: 'neural', results: [HIT] }))
    vi.stubGlobal('fetch', fetchMock)

    const hits = await searchCitations('proj-1', 'neural', { author: 'Smith, J.' }, 20)
    expect(hits).toEqual([HIT])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/projects/proj-1/citations/search')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'neural',
      limit: 20,
      strict: false,
      author: 'Smith, J.',
    })
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500 }))
    )
    await expect(searchCitations('proj-1', 'neural')).rejects.toThrow('HTTP 500')
  })
})

describe('getCitationContext', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('GETs the context window and returns the chunks array', async () => {
    const chunks = [{ id: 'paper-a::0', chunk_index: 0, word_count: 100, text: 'a' }]
    const fetchMock = vi.fn(() => jsonResponse({ stem: 'paper-a', chunks }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await getCitationContext('proj-1', 'paper-a', 0, 2)
    expect(out).toEqual(chunks)

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('/api/projects/proj-1/citations/context?')
    expect(url).toContain('stem=paper-a')
    expect(url).toContain('chunk_index=0')
    expect(url).toContain('radius=2')
  })
})

describe('CitationsView', () => {
  beforeEach(() => vi.unstubAllGlobals())

  // listSources → []; /citations/search → one hit.
  function routedFetch() {
    return vi.fn((url: string) =>
      url.includes('/citations/search')
        ? jsonResponse({ query: 'neural', results: [HIT] })
        : jsonResponse([])
    )
  }

  it('shows the prompt before any search is run', async () => {
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    expect(await screen.findByText(/Saisissez une requête/i)).toBeInTheDocument()
  })

  it('runs a search and renders a result card', async () => {
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'neural' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    // The snippet is split into per-word spans — the source title is the
    // stable proof a result card rendered.
    expect(await screen.findByText('Paper A')).toBeInTheDocument()
    // A snippet word is rendered (each word lives in its own span).
    expect(screen.getByText('convolutifs')).toBeInTheDocument()
  })

  it('bolds the searched word inside the snippet', async () => {
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'neurones' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    const word = await screen.findByText('neurones')
    expect(word.tagName).toBe('STRONG')
  })

  it('reports an error when the search request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/citations/search')
          ? Promise.resolve({ ok: false, status: 500 })
          : jsonResponse([])
      )
    )
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'neural' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    expect(await screen.findByText(/La recherche a échoué/i)).toBeInTheDocument()
  })

  function searchBody(fetchMock: ReturnType<typeof vi.fn>) {
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/citations/search'))
    return JSON.parse((call?.[1] as RequestInit).body as string)
  }

  it('strips connective words from the query sent to the backend', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'the neural network of brains' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    await screen.findByText('Paper A')
    expect(searchBody(fetchMock).query).toBe('neural network brains')
  })

  it('sends the raw phrase, connective words kept, in strict mode', async () => {
    const fetchMock = routedFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.click(screen.getByRole('button', { name: /phrase exacte/i }))
    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'réseaux de neurones' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    // Phrase present in HIT.text → card survives the strict filter.
    await screen.findByText('Paper A')
    // "de" kept — strict mode does not strip connective words.
    expect(searchBody(fetchMock).query).toBe('réseaux de neurones')
    expect(searchBody(fetchMock).strict).toBe(true)
  })

  it('drops cards without the exact phrase in strict mode', async () => {
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.click(screen.getByRole('button', { name: /phrase exacte/i }))
    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'concept totalement absent' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    expect(await screen.findByText(/Aucun passage ne correspond/i)).toBeInTheDocument()
  })

  it('keeps cards carrying the exact phrase in strict mode', async () => {
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.click(screen.getByRole('button', { name: /phrase exacte/i }))
    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'réseaux de neurones' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    expect(await screen.findByText('Paper A')).toBeInTheDocument()
  })

  it('paginates: a full page shows "load more", which widens the request', async () => {
    // A full 20-hit page back from the backend means more may exist.
    const fullPage = Array.from({ length: 20 }, (_, i) => ({ ...HIT, chunk_id: `paper-a::${i}` }))
    const fetchMock = vi.fn((url: string) =>
      url.includes('/citations/search')
        ? jsonResponse({ query: 'neural', results: fullPage })
        : jsonResponse([])
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'neural' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))

    const more = await screen.findByRole('button', { name: /voir plus de résultats/i })
    fireEvent.click(more)

    await waitFor(() => {
      const searchCalls = fetchMock.mock.calls.filter(([u]) =>
        String(u).includes('/citations/search')
      )
      const limits = searchCalls.map((call) => {
        const init = (call as unknown as [string, RequestInit])[1]
        return JSON.parse(init.body as string).limit
      })
      expect(limits).toEqual([20, 40])
    })
  })

  it('copies the source reference when the citation button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('fetch', routedFetch())
    render(<CitationsView projectId="proj-1" onOpenSource={() => {}} />)
    await screen.findByText(/Saisissez une requête/i)

    fireEvent.change(screen.getByLabelText('Rechercher des citations'), {
      target: { value: 'neural' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^rechercher$/i }))
    await screen.findByText('Paper A')

    fireEvent.click(screen.getByRole('button', { name: /copier la référence/i }))
    expect(writeText).toHaveBeenCalledWith('Smith, J. (2024). Paper A.')
  })
})

describe('formatReference', () => {
  const base: Omit<CitationHit, 'author' | 'year' | 'title'> = {
    chunk_id: 'c',
    text: 't',
    chunk_index: 0,
    chunk_total: 1,
    similarity: 1,
    stem: 's',
    filename: 'f.pdf',
  }

  it('formats author, year and title', () => {
    expect(
      formatReference({ ...base, author: 'Smith, J.', year: '2024', title: 'Deep Learning' })
    ).toBe('Smith, J. (2024). Deep Learning.')
  })

  it('omits the author when absent', () => {
    expect(
      formatReference({ ...base, author: '', year: '2024', title: 'Deep Learning' })
    ).toBe('(2024). Deep Learning.')
  })

  it('avoids a double period after an initial-terminated author', () => {
    expect(
      formatReference({ ...base, author: 'Smith, J.', year: '', title: 'Deep Learning' })
    ).toBe('Smith, J. Deep Learning.')
  })

  it('falls back to the filename when there is no title', () => {
    expect(formatReference({ ...base, author: '', year: '', title: '' })).toBe('f.pdf.')
  })
})
