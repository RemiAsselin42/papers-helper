import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_FORMATS, exportDocument, slugify } from '../components/writing/documentExport'

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics into single dashes', () => {
    expect(slugify('Mon Document !')).toBe('mon-document')
  })

  it('keeps unicode letters and digits', () => {
    expect(slugify('Étude 2026 : résultats')).toBe('étude-2026-résultats')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugify('  --Titre--  ')).toBe('titre')
  })

  it('falls back to "document" when nothing usable remains', () => {
    expect(slugify('')).toBe('document')
    expect(slugify('!!!')).toBe('document')
  })
})

// jsdom's Blob has no readable `.text()`; subclass it to keep the raw parts so
// the test can assert on the exported content.
class RecordingBlob extends Blob {
  readonly parts: string
  constructor(parts: BlobPart[] = [], opts?: BlobPropertyBag) {
    super(parts, opts)
    this.parts = parts.map((p) => String(p)).join('')
  }
}

describe('exportDocument format dispatch', () => {
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  const origBlob = globalThis.Blob
  let lastBlob: RecordingBlob
  let downloads: { name: string; type: string; content: string }[]

  beforeEach(() => {
    downloads = []
    globalThis.Blob = RecordingBlob as typeof Blob
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      lastBlob = b as RecordingBlob
      return 'blob:fake'
    })
    URL.revokeObjectURL = vi.fn()
    // jsdom's anchor click() would attempt navigation — replace it and record
    // the download name + the blob captured by createObjectURL just before.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloads.push({ name: this.download, type: lastBlob.type, content: lastBlob.parts })
    })
  })

  afterEach(() => {
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
    globalThis.Blob = origBlob
    vi.restoreAllMocks()
    document.querySelectorAll('iframe').forEach((f) => f.remove())
  })

  it('exposes the four supported formats', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['pdf', 'docx', 'html', 'txt'])
  })

  it('exports txt as a plain-text blob named after the slug', () => {
    exportDocument('txt', 'Ma Note', '<p>x</p>', 'texte brut')
    expect(downloads).toHaveLength(1)
    expect(downloads[0].name).toBe('ma-note.txt')
    expect(downloads[0].type).toBe('text/plain;charset=utf-8')
    expect(downloads[0].content).toBe('texte brut')
  })

  it('exports html with the editor body embedded', () => {
    exportDocument('html', 'Page', '<p>hello</p>', 'hello')
    expect(downloads[0].name).toBe('page.html')
    expect(downloads[0].type).toBe('text/html;charset=utf-8')
    expect(downloads[0].content).toContain('<p>hello</p>')
  })

  it('exports docx as a Word-compatible .doc file', () => {
    exportDocument('docx', 'Rapport Final', '<p>x</p>', 'x')
    expect(downloads[0].name).toBe('rapport-final.doc')
    expect(downloads[0].type).toBe('application/msword')
  })

  it('renders pdf through a print iframe instead of a blob download', () => {
    exportDocument('pdf', 'Impression', '<p>x</p>', 'x')
    expect(downloads).toHaveLength(0)
    expect(document.querySelector('iframe')).not.toBeNull()
  })
})
