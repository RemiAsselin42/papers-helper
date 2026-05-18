import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanGeneratedAbstract,
  generateAbstractForStem,
  generateCategoriesFromAbstract,
} from './enrich'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeSseResponse(payloads: unknown[]): Response {
  const chunks = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

describe('generateAbstractForStem', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the concatenated tokens streamed from /condense', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse([
        { token: 'Hello ' },
        { token: 'world.' },
        '[DONE]',
      ])
    )
    const tokens: string[] = []
    const out = await generateAbstractForStem({
      projectId: 'p1',
      stem: 'doc1',
      model: 'llama3',
      provider: 'ollama',
      onToken: (t) => tokens.push(t),
    })
    expect(out).toBe('Hello world.')
    expect(tokens).toEqual(['Hello ', 'world.'])
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('throws when /condense responds with a non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 })
    )
    await expect(
      generateAbstractForStem({
        projectId: 'p1',
        stem: 'doc1',
        model: 'llama3',
        provider: 'ollama',
      })
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('cleanGeneratedAbstract', () => {
  it('leaves a clean plain-text abstract untouched', () => {
    const txt = 'Cet ouvrage analyse les contournements.\n\nIl en décrit les causes.'
    expect(cleanGeneratedAbstract(txt)).toBe(txt)
  })

  it('returns an empty string for empty input', () => {
    expect(cleanGeneratedAbstract('   ')).toBe('')
  })

  it('strips bold, headings and list markers', () => {
    const out = cleanGeneratedAbstract(
      '## Résumé\n\n**Important** : les contournements.\n- premier point\n1. second point'
    )
    expect(out).not.toContain('**')
    expect(out).not.toContain('##')
    expect(out).toContain('Important : les contournements.')
    expect(out).toContain('premier point')
    expect(out).toContain('second point')
  })

  it('drops a leading chatty preamble paragraph', () => {
    const out = cleanGeneratedAbstract(
      "Here's a general overview of the document:\n\nL'ouvrage défend une thèse claire."
    )
    expect(out).toBe("L'ouvrage défend une thèse claire.")
  })

  it('drops a trailing meta-conclusion paragraph', () => {
    const out = cleanGeneratedAbstract(
      "L'ouvrage défend une thèse.\n\nOverall, these summaries show its complexity."
    )
    expect(out).toBe("L'ouvrage défend une thèse.")
  })

  it('strips the preamble and Markdown from a llama3-style structured answer', () => {
    const raw = [
      'What a treasure trove of text extracts!',
      '',
      "After carefully reviewing each summary, I've noticed a common concept.",
      '',
      "Here's a general overview of the main themes and ideas:",
      '',
      "L'ouvrage analyse les contournements et leurs causes.",
      '',
      'Overall, these summaries demonstrate the importance of the topic.',
    ].join('\n')
    const out = cleanGeneratedAbstract(raw)
    expect(out).not.toMatch(/treasure trove/i)
    expect(out).not.toMatch(/^after /i)
    expect(out).not.toMatch(/^here's/i)
    expect(out).not.toMatch(/overall/i)
    expect(out).not.toContain('**')
    expect(out).toContain("L'ouvrage analyse les contournements")
  })

  it('never strips every paragraph — keeps the last one if all look meta', () => {
    const out = cleanGeneratedAbstract("Here is the summary you asked for.")
    expect(out).toBe('Here is the summary you asked for.')
  })
})

describe('generateCategoriesFromAbstract', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses the /categorize JSON array into a deduped list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ text: '["A", "B", "a"]' })
    )
    const out = await generateCategoriesFromAbstract({
      projectId: 'p1',
      abstract: 'an abstract',
      model: 'llama3',
      provider: 'ollama',
    })
    expect(out).toEqual(['A', 'B'])
  })

  it('throws when the LLM emits unparseable output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ text: 'this is just prose' })
    )
    await expect(
      generateCategoriesFromAbstract({
        projectId: 'p1',
        abstract: 'an abstract',
        model: 'llama3',
        provider: 'ollama',
      })
    ).rejects.toThrow(/inexploitable/i)
  })

  it('throws on a non-ok /categorize status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }))
    await expect(
      generateCategoriesFromAbstract({
        projectId: 'p1',
        abstract: 'an abstract',
        model: 'llama3',
        provider: 'ollama',
      })
    ).rejects.toThrow(/HTTP 502/)
  })
})
