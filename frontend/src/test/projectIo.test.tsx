import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importProject } from '../api/projectIo'
import { ProjectIoView } from '../components/projectio/ProjectIoView'

function jsonRes(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  })
}

const PROJECT = { id: 'p1', name: 'Mon Projet', created_at: 't' }

/** Routes the import endpoint by `mode`: `auto` conflicts, `replace` /
 * `duplicate` succeed — mirrors the backend conflict flow. */
function ioFetch() {
  return vi.fn((url: string) => {
    const u = String(url)
    if (u.includes('mode=auto')) {
      return jsonRes({ detail: { id: 'p1', name: 'Mon Projet' } }, 409)
    }
    if (u.includes('mode=duplicate')) {
      return jsonRes({ id: 'dup-1', name: 'Mon Projet (copie)', created_at: 't' }, 201)
    }
    return jsonRes(PROJECT, 201) // replace
  })
}

function pickFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, {
    target: { files: [new File(['zip-bytes'], 'p.papers.zip', { type: 'application/zip' })] },
  })
}

describe('importProject API client', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('returns a conflict result on HTTP 409', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({ detail: { id: 'p1', name: 'Projet' } }, 409)))
    const res = await importProject(new File(['z'], 'p.zip'), 'auto')
    expect(res).toEqual({ kind: 'conflict', id: 'p1', name: 'Projet' })
  })

  it('returns an ok result carrying the imported project on 201', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes(PROJECT, 201)))
    const res = await importProject(new File(['z'], 'p.zip'), 'replace')
    expect(res).toEqual({ kind: 'ok', project: PROJECT })
  })

  it('throws the backend detail message on a non-conflict error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({ detail: 'Archive trop volumineuse' }, 413)))
    await expect(importProject(new File(['z'], 'p.zip'))).rejects.toThrow(
      'Archive trop volumineuse'
    )
  })
})

describe('ProjectIoView conflict flow', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('imports directly when there is no conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes(PROJECT, 201)))
    const onImported = vi.fn()
    const { container } = render(
      <ProjectIoView projectId="p1" projectName="Mon Projet" onImported={onImported} />
    )
    pickFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Importer' }))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(PROJECT, 'new'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the conflict dialog then replaces on confirmation', async () => {
    vi.stubGlobal('fetch', ioFetch())
    const onImported = vi.fn()
    const { container } = render(
      <ProjectIoView projectId="p1" projectName="Mon Projet" onImported={onImported} />
    )
    pickFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Importer' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Mon Projet')

    fireEvent.click(screen.getByRole('button', { name: 'Remplacer' }))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(PROJECT, 'replace'))
  })

  it('duplicates from the conflict dialog', async () => {
    vi.stubGlobal('fetch', ioFetch())
    const onImported = vi.fn()
    const { container } = render(
      <ProjectIoView projectId="p1" projectName="Mon Projet" onImported={onImported} />
    )
    pickFile(container)
    fireEvent.click(screen.getByRole('button', { name: 'Importer' }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Dupliquer' }))

    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(
        { id: 'dup-1', name: 'Mon Projet (copie)', created_at: 't' },
        'new'
      )
    )
  })
})
