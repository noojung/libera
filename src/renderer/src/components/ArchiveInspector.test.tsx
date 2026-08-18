import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveInspector } from './ArchiveInspector'
import { renderWithI18n } from '../test/render'
import { installElectronApi } from '../test/electronApi'

const createObjectUrl = vi.fn(() => 'blob:archive-preview')
const revokeObjectUrl = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })

beforeEach(() => {
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
})

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
  }, 30_000)

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

  it('loads and displays a truncated text preview when a file is clicked', async () => {
    let resolvePreview!: (value: any) => void
    const pendingPreview = new Promise(resolve => { resolvePreview = resolve })
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['preview.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'notes.txt', name: 'notes.txt', isDirectory: false, size: 2 * 1024 * 1024 }
      ])),
      previewArchiveEntry: vi.fn().mockReturnValue(pendingPreview)
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /notes\.txt/ }))

    expect(screen.getByRole('dialog', { name: 'File preview' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading file contents...')
    expect(api.previewArchiveEntry).toHaveBeenCalledWith(
      'preview.zip',
      'entry-0',
      expect.stringMatching(/^archive-preview-/)
    )

    resolvePreview({
      success: true,
      result: {
        kind: 'text',
        text: 'preview contents',
        encoding: 'utf-8',
        truncated: true,
        previewedBytes: 1024 * 1024,
        totalBytes: 2 * 1024 * 1024
      }
    })
    expect(await screen.findByText('preview contents')).toBeInTheDocument()
    expect(screen.getByText('Showing the first 1 MiB of 2 MiB.')).toBeInTheDocument()
  })

  it('shows translated preview errors for non-text files', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['binary.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'binary.bin', name: 'binary.bin', isDirectory: false, size: 4 }
      ])),
      previewArchiveEntry: vi.fn().mockResolvedValue({ success: false, errorCode: 'notText' })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /binary\.bin/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This file does not appear to contain supported text.')
  })

  it('displays image previews and revokes their Blob URLs when closed', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['images.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'photo.png', name: 'photo.png', isDirectory: false, size: 24 }
      ])),
      previewArchiveEntry: vi.fn().mockResolvedValue({
        success: true,
        result: {
          kind: 'image',
          data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          mediaType: 'image/png',
          width: 320,
          height: 200,
          previewedBytes: 24,
          totalBytes: 24
        }
      })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /photo\.png/ }))

    const image = await screen.findByRole('img', { name: 'Preview of photo.png' })
    expect(image).toHaveAttribute('src', 'blob:archive-preview')
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(screen.getByText('Format: PNG')).toBeInTheDocument()
    expect(screen.getByText('320 × 200 · 24 B')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close file preview' }))
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:archive-preview')
  })

  it('shows an error when Chromium cannot decode validated image bytes', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['images.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'broken.png', name: 'broken.png', isDirectory: false, size: 24 }
      ])),
      previewArchiveEntry: vi.fn().mockResolvedValue({
        success: true,
        result: {
          kind: 'image',
          data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          mediaType: 'image/png',
          width: 10,
          height: 10,
          previewedBytes: 24,
          totalBytes: 24
        }
      })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /broken\.png/ }))
    fireEvent.error(await screen.findByRole('img'))

    expect(await screen.findByRole('alert')).toHaveTextContent('This image is damaged or cannot be decoded.')
  })

  it('cancels an in-flight preview when the modal closes and ignores its late response', async () => {
    let resolvePreview!: (value: any) => void
    const pendingPreview = new Promise(resolve => { resolvePreview = resolve })
    const previewArchiveEntry = vi.fn().mockReturnValue(pendingPreview)
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['preview.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'notes.txt', name: 'notes.txt', isDirectory: false, size: 5 }
      ])),
      previewArchiveEntry
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /notes\.txt/ }))
    const requestId = previewArchiveEntry.mock.calls[0][2]
    await user.click(screen.getByRole('button', { name: 'Close file preview' }))

    expect(api.cancelArchivePreview).toHaveBeenCalledWith(requestId)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    resolvePreview({
      success: true,
      result: { kind: 'text', text: 'late contents', encoding: 'utf-8', truncated: false, previewedBytes: 5, totalBytes: 5 }
    })
    await waitFor(() => expect(screen.queryByText('late contents')).not.toBeInTheDocument())
  })
})
