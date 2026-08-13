import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArchiveInspector } from './ArchiveInspector'
import { renderWithI18n } from '../test/render'
import { installElectronApi } from '../test/electronApi'

const inspection = (entries: any[]) => ({
  success: true,
  result: {
    format: 'ZIP',
    totalFiles: entries.filter(entry => !entry.isDirectory).length,
    totalUncompressedSize: null,
    overallRatio: null,
    entries
  }
})

describe('ArchiveInspector', () => {
  it('opens an archive, displays unknown metadata, and navigates folders', async () => {
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['C:\\archives\\sample.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { path: 'folder/', name: 'folder', isDirectory: true, size: 0 },
        { path: 'folder/inside.txt', name: 'inside.txt', isDirectory: false, size: 12, compressedSize: 8, ratio: 33 },
        { path: 'root.txt', name: 'root.txt', isDirectory: false, size: 4, compressedSize: 4, ratio: 0 }
      ]))
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    await screen.findByText('root.txt')
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /folder/ }))
    expect(screen.getByText('inside.txt')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive root' }))
    expect(screen.getByText('root.txt')).toBeInTheDocument()
    expect(api.inspectArchive).toHaveBeenCalledWith('C:\\archives\\sample.zip')
  })

  it('loads entries in pages of 500', async () => {
    const entries = Array.from({ length: 501 }, (_, index) => ({
      path: `file-${String(index).padStart(3, '0')}.txt`,
      name: `file-${String(index).padStart(3, '0')}.txt`,
      isDirectory: false,
      size: index,
      compressedSize: index,
      ratio: 0
    }))
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['many.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection(entries))
    })
    renderWithI18n(<ArchiveInspector />)
    fireEvent.click(screen.getByRole('button', { name: 'Open file...' }))
    await screen.findByText('file-499.txt')
    expect(screen.queryByText('file-500.txt')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load 1 more' }))
    expect(screen.getByText('file-500.txt')).toBeInTheDocument()
  }, 10_000)

  it('searches descendants of the current folder', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['search.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { path: 'folder/', name: 'folder', isDirectory: true, size: 0 },
        { path: 'folder/match.txt', name: 'match.txt', isDirectory: false, size: 10 },
        { path: 'folder/other.txt', name: 'other.txt', isDirectory: false, size: 20 },
        { path: 'outside.txt', name: 'outside.txt', isDirectory: false, size: 30 }
      ]))
    })
    renderWithI18n(<ArchiveInspector />)
    fireEvent.click(screen.getByRole('button', { name: 'Open file...' }))
    await screen.findByText('folder')
    fireEvent.click(screen.getByRole('button', { name: /folder/ }))
    fireEvent.change(screen.getByPlaceholderText(/Search this folder/), { target: { value: 'match' } })
    expect(screen.getByText('match.txt')).toBeInTheDocument()
    expect(screen.queryByText('other.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('outside.txt')).not.toBeInTheDocument()
  })

  it('shows loading and translated inspection errors', async () => {
    let resolveInspection!: (value: any) => void
    const pending = new Promise(resolve => { resolveInspection = resolve })
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['broken.zip']),
      inspectArchive: vi.fn().mockReturnValue(pending)
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    expect(screen.getByText(/Analyzing archive headers/)).toBeInTheDocument()

    resolveInspection({ success: false, errorCode: 'unsafeArchive' })
    await waitFor(() => expect(screen.getByText('This archive cannot be extracted safely.')).toBeInTheDocument())
  })

  it('inspects the first dropped file using the Electron path bridge', async () => {
    const api = installElectronApi({
      getPathForFile: vi.fn(() => 'C:\\drop\\dropped.zip'),
      inspectArchive: vi.fn().mockResolvedValue(inspection([]))
    })
    const { container } = renderWithI18n(<ArchiveInspector />)
    fireEvent.drop(container.firstElementChild!, {
      dataTransfer: { files: [new File(['zip'], 'dropped.zip')] }
    })
    await waitFor(() => expect(api.inspectArchive).toHaveBeenCalledWith('C:\\drop\\dropped.zip'))
  })
})
