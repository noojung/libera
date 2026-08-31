import React from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchiveInspector } from './ArchiveInspector'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

const createObjectUrl = vi.fn(() => 'blob:archive-preview')
const revokeObjectUrl = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })

beforeEach(() => {
  createObjectUrl.mockClear()
  revokeObjectUrl.mockClear()
  localStorage.removeItem('libera_expert_mode')
})

const inspection = (entries: any[], overrides: Record<string, unknown> = {}) => ({
  success: true,
  result: {
    format: 'ZIP',
    totalFiles: entries.filter(entry => !entry.isDirectory).length,
    totalUncompressedSize: null,
    totalCompressedSize: 0,
    overallRatio: null,
    ...overrides,
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
    expect(api.inspectArchive).toHaveBeenCalledWith('C:\\archives\\sample.zip', undefined)
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

  it('shows the total compressed size and a decimal savings percentage', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['precise.7z']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([], {
        format: '7Z',
        totalUncompressedSize: 1000,
        totalCompressedSize: 986,
        overallRatio: 1.4
      }))
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    expect(await screen.findByText('986 B')).toBeInTheDocument()
    expect(screen.getByText('1.4% saved')).toBeInTheDocument()
  })

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
    await waitFor(() => expect(api.inspectArchive).toHaveBeenCalledWith('C:\\drop\\dropped.zip', undefined))
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
      expect.stringMatching(/^archive-preview-/),
      undefined
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

  it('identifies a split archive and expands its complete volume list', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['/archives/archive.z02']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([], {
        archivePath: '/archives/archive.zip',
        volumeCount: 3,
        totalCompressedSize: 3584,
        volumes: [
          { path: '/archives/archive.z01', name: 'archive.z01', size: 1024 },
          { path: '/archives/archive.z02', name: 'archive.z02', size: 2048 },
          { path: '/archives/archive.zip', name: 'archive.zip', size: 512 }
        ]
      }))
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    const showVolumes = await screen.findByRole('button', { name: 'Show split archive volumes' })
    expect(showVolumes).toHaveTextContent('Split archive · 3 volumes')
    expect(screen.getByText('/archives/archive.zip')).toBeInTheDocument()
    expect(screen.queryByText('/archives/archive.z02')).not.toBeInTheDocument()
    expect(screen.getByText('Split volumes')).toBeInTheDocument()
    expect(screen.queryByText('archive.z01')).not.toBeInTheDocument()

    await user.click(showVolumes)
    const volumeList = screen.getByRole('region', { name: 'Split volumes' })
    expect(within(volumeList).getByText('These 3 files are connected as one logical archive.')).toBeInTheDocument()
    expect(within(volumeList).getByText('archive.z01')).toBeInTheDocument()
    expect(within(volumeList).getByText('archive.z02')).toBeInTheDocument()
    expect(within(volumeList).getByText('archive.zip')).toBeInTheDocument()
    expect(within(volumeList).getByText('/archives/archive.z02')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hide split archive volumes' }))
    expect(screen.queryByRole('region', { name: 'Split volumes' })).not.toBeInTheDocument()
  })

  it('uses the first 7z volume as the representative preview path', async () => {
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['/archives/archive.7z.003']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'notes.txt', name: 'notes.txt', isDirectory: false, size: 5 }
      ], {
        archivePath: '/archives/archive.7z.001',
        format: '7Z',
        volumeCount: 3,
        volumes: [
          { path: '/archives/archive.7z.001', name: 'archive.7z.001', size: 1024 },
          { path: '/archives/archive.7z.002', name: 'archive.7z.002', size: 1024 },
          { path: '/archives/archive.7z.003', name: 'archive.7z.003', size: 512 }
        ]
      })),
      previewArchiveEntry: vi.fn().mockResolvedValue({ success: false, errorCode: 'notText' })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    expect(await screen.findByText('/archives/archive.7z.001')).toBeInTheDocument()
    expect(screen.queryByText('/archives/archive.7z.003')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /notes\.txt/ }))
    expect(api.previewArchiveEntry).toHaveBeenCalledWith(
      '/archives/archive.7z.001',
      'entry-0',
      expect.stringMatching(/^archive-preview-/),
      undefined
    )
  })

  it('explains when a split volume disappears before an entry preview', async () => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['archive.7z.001']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'notes.txt', name: 'notes.txt', isDirectory: false, size: 5 }
      ])),
      previewArchiveEntry: vi.fn().mockResolvedValue({ success: false, errorCode: 'splitVolumeMissing' })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByRole('button', { name: /notes\.txt/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A split archive volume is missing or incomplete. Restore the complete volume set and reopen the archive.'
    )
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
  it('prompts for a password when the archive headers are encrypted, then lists it', async () => {
    const inspectArchive = vi.fn()
      // A header-encrypted 7z cannot be listed at all until a password arrives.
      .mockResolvedValueOnce({ success: false, code: 'PASSWORD_REQUIRED', errorCode: 'passwordRequired' })
      .mockResolvedValueOnce({ success: false, code: 'WRONG_ZIP_PASSWORD', errorCode: 'wrongArchivePassword' })
      .mockResolvedValueOnce(inspection([
        { id: 'entry-0', path: 'secret.txt', name: 'secret.txt', isDirectory: false, size: 5 }
      ]))
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['hidden.7z']),
      inspectArchive
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    expect(await screen.findByText('Password-protected archive')).toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Enter password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    // The field keeps the rejected value, as it does on the extract path.
    await user.clear(screen.getByPlaceholderText('Enter password'))
    await user.type(screen.getByPlaceholderText('Enter password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(await screen.findByText('secret.txt')).toBeInTheDocument()
    expect(inspectArchive).toHaveBeenLastCalledWith('hidden.7z', 'hunter2')
    expect(api.inspectArchive).toHaveBeenCalledTimes(3)
  })

  it('asks for a password when previewing an encrypted entry, then shows it', async () => {
    // A ZIP central directory lists fine without a password, so the archive
    // opens and only the preview needs one.
    const previewArchiveEntry = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'PASSWORD_REQUIRED', errorCode: 'passwordRequired' })
      .mockResolvedValueOnce({ success: false, code: 'WRONG_ZIP_PASSWORD', errorCode: 'wrongArchivePassword' })
      .mockResolvedValue({
        success: true,
        result: { kind: 'text', text: 'classified', encoding: 'utf-8', truncated: false, previewedBytes: 10, totalBytes: 10 }
      })
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['secret.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'secret.txt', name: 'secret.txt', isDirectory: false, size: 10 }
      ])),
      previewArchiveEntry
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))
    await user.click(await screen.findByText('secret.txt'))

    expect(await screen.findByText('Password-protected archive')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Enter password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    await user.clear(screen.getByPlaceholderText('Enter password'))
    await user.type(screen.getByPlaceholderText('Enter password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(await screen.findByText('classified')).toBeInTheDocument()
    expect(previewArchiveEntry).toHaveBeenLastCalledWith('secret.zip', 'entry-0', expect.any(String), 'hunter2')
  })

  it('keeps the password for later previews of the same archive', async () => {
    const previewArchiveEntry = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'PASSWORD_REQUIRED', errorCode: 'passwordRequired' })
      .mockResolvedValue({
        success: true,
        result: { kind: 'text', text: 'body', encoding: 'utf-8', truncated: false, previewedBytes: 4, totalBytes: 4 }
      })
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['secret.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        { id: 'entry-0', path: 'one.txt', name: 'one.txt', isDirectory: false, size: 4 },
        { id: 'entry-1', path: 'two.txt', name: 'two.txt', isDirectory: false, size: 4 }
      ])),
      previewArchiveEntry
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    await user.click(await screen.findByText('one.txt'))
    await user.type(await screen.findByPlaceholderText('Enter password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByText('body')).toBeInTheDocument()

    // The second entry must not prompt again.
    await user.click(screen.getByRole('button', { name: 'Close file preview' }))
    await user.click(await screen.findByText('two.txt'))
    await waitFor(() => expect(previewArchiveEntry).toHaveBeenCalledTimes(3))
    expect(previewArchiveEntry).toHaveBeenLastCalledWith('secret.zip', 'entry-1', expect.any(String), 'hunter2')
    expect(screen.queryByText('Password-protected archive')).not.toBeInTheDocument()
  })

  it('shows technical metadata and Hex/text views in expert mode', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    const api = installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['expert.zip']),
      inspectArchive: vi.fn().mockResolvedValue(inspection([
        {
          id: 'entry-0',
          path: 'payload.bin',
          name: 'payload.bin',
          isDirectory: false,
          size: 2,
          compressedSize: 2,
          ratio: 0,
          codec: 'Store',
          encryptionMethod: 'AES-256',
          crc32: '0x4D170E0E',
          mode: 0o100755,
          modeString: '-rwxr-xr-x',
          offset: 64
        }
      ], {
        headerInfo: {
          signature: '50 4B 03 04 (ZIP)',
          formatVersion: '2.0',
          codecSummary: 'Store',
          encryptionAlgorithm: 'AES-256',
          solid: false,
          centralDirectoryOffset: 128,
          centralDirectorySize: 48
        }
      })),
      previewArchiveEntry: vi.fn().mockResolvedValue({
        success: true,
        result: {
          kind: 'binary',
          rawBytes: Uint8Array.from([0x48, 0x69]),
          truncated: false,
          previewedBytes: 2,
          totalBytes: 2
        }
      })
    })
    const { user } = renderWithI18n(<ArchiveInspector />)
    await user.click(screen.getByRole('button', { name: 'Open file...' }))

    expect(await screen.findByText('50 4B 03 04 (ZIP)')).toBeInTheDocument()
    expect(screen.getByText('0x4D170E0E')).toBeInTheDocument()
    expect(screen.getByText('0755 / -rwxr-xr-x')).toBeInTheDocument()
    expect(screen.getByText('0x40')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /payload\.bin/ }))
    expect(api.previewArchiveEntry).toHaveBeenCalledWith(
      'expert.zip',
      'entry-0',
      expect.stringMatching(/^archive-preview-/),
      { password: undefined, includeRawBytes: true }
    )
    expect(await screen.findByText(/00000000\s+48 69/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Text' }))
    expect(screen.getByText('Hi')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Encoding' })).toBeInTheDocument()
  })
})
