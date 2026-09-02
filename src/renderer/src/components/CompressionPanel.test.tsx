import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompressionPanel } from './CompressionPanel'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

const item = { path: 'C:\\input.txt', name: 'input.txt', isDirectory: false, size: 2048 }

describe('CompressionPanel', () => {
  beforeEach(() => {
    localStorage.removeItem('libera_expert_mode')
  })

  it('uses default output settings and submits compression options', async () => {
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start compression 🚀' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))
    expect(onStart).toHaveBeenCalledWith({
      format: 'zip',
      level: 6,
      outputPath: 'C:\\output\\archive.zip',
      password: undefined,
      splitSize: undefined
    })
  })

  it('sends a preset split size once splitting is enabled', async () => {
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)
    await user.click(screen.getByRole('checkbox', { name: /Split into volumes/ }))
    await user.click(screen.getByRole('button', { name: '700 MB (CD)' }))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ splitSize: 700 * 1024 * 1024 }))
  })

  it('rejects a custom split size below the minimum volume', async () => {
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)
    await user.click(screen.getByRole('checkbox', { name: /Split into volumes/ }))
    await user.click(screen.getByRole('button', { name: 'Custom' }))
    await user.clear(screen.getByPlaceholderText('Size'))
    await user.type(screen.getByPlaceholderText('Size'), '0')
    expect(screen.getByText('Each volume must be at least 1 MB.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start compression 🚀' })).toBeDisabled()

    await user.clear(screen.getByPlaceholderText('Size'))
    await user.type(screen.getByPlaceholderText('Size'), '2')
    await user.click(screen.getByRole('button', { name: 'GB' }))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ splitSize: 2 * 1024 * 1024 * 1024 }))
  })

  it('validates ZIP passwords and sends a selected save path', async () => {
    const api = installElectronApi({ selectSaveLocation: vi.fn().mockResolvedValue('D:\\secure.zip') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start compression 🚀' })).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Click Browse to choose a save location')).toHaveValue('D:\\secure.zip'))
    fireEvent.change(screen.getByRole('slider'), { target: { value: '9' } })
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(api.selectSaveLocation).toHaveBeenCalledWith('archive.zip', 'zip', expect.any(Object))
    expect(onStart).toHaveBeenCalledWith({
      format: 'zip',
      level: 9,
      outputPath: 'D:\\secure.zip',
      password: 'secret',
      encryptFileNames: undefined,
      splitSize: undefined
    })
  })

  it('hides password inputs for formats that cannot encrypt, and disables empty jobs', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Start compression 🚀' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '.TAR' }))
    expect(screen.queryByPlaceholderText('Enter password')).not.toBeInTheDocument()
  })

  it('offers both split and a password for 7z, and explains its stronger encryption', async () => {
    installElectronApi()
    const onStart = vi.fn()
    const { user } = renderWithI18n(
      <CompressionPanel items={[{ path: '/a', name: 'a', isDirectory: false, size: 1 }]} onStartCompress={onStart} />
    )

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByText('Split into volumes')).toBeInTheDocument()

    // The name-hiding option only appears once a usable password is entered.
    expect(screen.queryByText('Hide the file names too')).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    expect(screen.queryByText('Hide the file names too')).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')

    expect(screen.getByText(/AES-256 encryption will be used/)).toBeInTheDocument()
    // ... and only in expert mode, which is off until now.
    expect(screen.queryByText('Hide the file names too')).not.toBeInTheDocument()
    fireEvent(window, new CustomEvent('libera-expert-mode-change', { detail: { enabled: true } }))
    await user.click(screen.getByText('Hide the file names too'))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      password: 'secret',
      encryptFileNames: true
    }))
  })

  it('drops the name-hiding option when switching away from 7z', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi()
    const onStart = vi.fn()
    const { user } = renderWithI18n(
      <CompressionPanel items={[{ path: '/a', name: 'a', isDirectory: false, size: 1 }]} onStartCompress={onStart} />
    )

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    // The option is there from the start, before any password is entered.
    expect(screen.getByRole('checkbox', { name: /Hide the file names too/ })).toBeEnabled()
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')
    await user.click(screen.getByText('Hide the file names too'))

    // ZIP keeps the password but has no header to encrypt.
    await user.click(screen.getByRole('button', { name: '.ZIP' }))
    expect(screen.queryByText('Hide the file names too')).not.toBeInTheDocument()
    expect(screen.getByText(/Compatibility-focused ZIP encryption/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: 'zip',
      password: 'secret',
      encryptFileNames: undefined
    }))
  })

  it('names the levels each family uses and snaps 7z to its own scale', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)

    const slider = () => screen.getByRole('slider')
    expect(screen.getByText('6 - Normal')).toBeInTheDocument()

    fireEvent.change(slider(), { target: { value: '0' } })
    expect(screen.getByText('0 - Store')).toBeInTheDocument()
    fireEvent.change(slider(), { target: { value: '9' } })
    expect(screen.getByText('9 - Maximum')).toBeInTheDocument()
    fireEvent.change(slider(), { target: { value: '4' } })
    expect(screen.getByText('4')).toBeInTheDocument()

    // 7z has six steps, so the slider positions map onto -mx values.
    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(slider()).toHaveAttribute('max', '5')
    fireEvent.change(slider(), { target: { value: '0' } })
    expect(screen.getByText('0 - Store')).toBeInTheDocument()
    fireEvent.change(slider(), { target: { value: '3' } })
    expect(screen.getByText('5 - Normal')).toBeInTheDocument()
    fireEvent.change(slider(), { target: { value: '5' } })
    expect(screen.getByText('9 - Ultra')).toBeInTheDocument()
  })

  it('carries the level to the closest step the new format has', async () => {
    installElectronApi()
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByText('5 - Normal')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ format: '7z', level: 5 }))
  })

  it('hides the compression level for TAR, which cannot compress', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)

    expect(screen.getByText('Compression level')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '.TAR' }))
    expect(screen.queryByText('Compression level')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '.TAR.GZ' }))
    expect(screen.getByText('Compression level')).toBeInTheDocument()
  })

  it('hides the empty expert settings card for TAR', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)

    expect(screen.getByText(/Expert compression settings/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '.TAR' }))
    expect(screen.queryByText(/Expert compression settings/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '.TAR.GZ' }))
    expect(screen.getByText(/Expert compression settings/)).toBeInTheDocument()
  })

  it('shows the volume names each split format actually produces', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)
    expect(screen.getByText(/archive\.z01, archive\.z02 … archive\.zip/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByText(/archive\.7z\.001, archive\.7z\.002/)).toBeInTheDocument()
  })

  it('names TGZ archives .tar.gz, including a save path that came back as .tgz', async () => {
    const api = installElectronApi({
      getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output'),
      selectSaveLocation: vi.fn().mockResolvedValue('D:\\backup.tgz')
    })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.TAR.GZ' }))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: 'tgz',
      outputPath: 'C:\\output\\archive.tar.gz'
    }))

    await user.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(api.selectSaveLocation).toHaveBeenCalledWith('archive.tar.gz', 'gz', expect.any(Object)))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({ outputPath: 'D:\\backup.tar.gz' }))
  })

  it('submits ZIP encryption with a per-file Deflate strategy and compression strength', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    expect(screen.getByText(/Expert compression settings/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'ZIP compression method' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Deflate strategy' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Deflate strategy for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'RLE (Match distance 1 only)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for input.txt' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')
    await user.click(screen.getByRole('combobox', { name: 'Encryption algorithm' }))
    await user.click(screen.getByRole('option', { name: 'AES-128 (WinZip AES 128-bit)' }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      encryptionMethod: 'aes128',
      zipMethodOverrides: [{
        sourcePath: 'C:\\input.txt',
        scope: 'file',
        method: 'auto',
        deflateStrategy: 'rle',
        level: 9
      }],
      deflateStrategy: undefined,
      level: 6,
      memLevel: undefined,
      password: 'secret'
    }))
  })

  it('submits a per-file LZMA method without global ZIP codec controls', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    expect(screen.queryByRole('combobox', { name: 'ZIP compression method' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    expect(screen.queryByRole('combobox', { name: 'Deflate strategy for input.txt' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))

    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      zipMethodOverrides: [{ sourcePath: 'C:\\input.txt', scope: 'file', method: 'lzma' }],
      deflateStrategy: undefined,
      memLevel: undefined
    }))
  })

  it('configures recursive and per-file ZIP methods in the expert modal', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    const source = { path: '/source', name: 'source', isDirectory: true, size: 4096 }
    const photo = { path: '/source/photo.jpg', name: 'photo.jpg', isDirectory: false, size: 2048 }
    const api = installElectronApi({
      platform: 'macos',
      getDefaultOutputDir: vi.fn().mockResolvedValue('/output'),
      listArchiveInputChildren: vi.fn().mockResolvedValue([photo])
    })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[source]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Per-file compression settings' })
    expect(dialog.parentElement).toHaveClass('zip-method-modal--macos')
    expect(dialog.querySelector('.lucide-files')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Compression method for source' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for source' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))
    // The whole folder identity area, including its displayed path, toggles
    // expansion instead of requiring a precise click on the chevron.
    await user.click(screen.getByText('/source'))
    await waitFor(() => expect(api.listArchiveInputChildren).toHaveBeenCalledWith('/source'))

    expect(await screen.findByRole('combobox', { name: 'Compression strength for photo.jpg' }))
      .toHaveTextContent('9 - Maximum')
    await user.click(await screen.findByRole('combobox', { name: 'Compression method for photo.jpg' }))
    await user.click(screen.getByRole('option', { name: 'Store (0)' }))
    expect(screen.getByRole('combobox', { name: 'Compression method for source' })).toHaveTextContent('Mixed methods')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('2 overrides')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: 'zip',
      zipMethodOverrides: [
        { sourcePath: '/source', scope: 'tree', method: 'lzma', level: 9 },
        { sourcePath: '/source/photo.jpg', scope: 'file', method: 'store' }
      ]
    }))
  })

  it('applies automatic folder tuning to child files without inheritance selections', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    const source = { path: '/source', name: 'source', isDirectory: true, size: 4096 }
    const child = { path: '/source/notes.txt', name: 'notes.txt', isDirectory: false, size: 2048 }
    installElectronApi({
      getDefaultOutputDir: vi.fn().mockResolvedValue('/output'),
      listArchiveInputChildren: vi.fn().mockResolvedValue([child])
    })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[source]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    expect(screen.getByRole('combobox', { name: 'Compression method for source' }))
      .toHaveTextContent('Automatic (Deflate / Store)')
    expect(screen.queryByText(/Inherit/)).not.toBeInTheDocument()

    await user.click(screen.getByText('/source'))
    await screen.findByRole('combobox', { name: 'Compression method for notes.txt' })
    await user.click(screen.getByRole('combobox', { name: 'Deflate strategy for source' }))
    await user.click(screen.getByRole('option', { name: 'RLE (Match distance 1 only)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for source' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))

    expect(screen.getByRole('combobox', { name: 'Deflate strategy for notes.txt' }))
      .toHaveTextContent('RLE (Match distance 1 only)')
    expect(screen.getByRole('combobox', { name: 'Compression strength for notes.txt' }))
      .toHaveTextContent('9 - Maximum')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      zipMethodOverrides: [{
        sourcePath: '/source',
        scope: 'tree',
        method: 'auto',
        deflateStrategy: 'rle',
        level: 9
      }]
    }))
  })

  it('keeps the global Store level while giving an explicitly compressed file level one', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('/output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[{ ...item, path: '/input.txt' }]} onStartCompress={onStart} />)

    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '0' } })
    expect(screen.getByText('0 - Store')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByText('0 - Store')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      level: 0,
      zipMethodOverrides: [{ sourcePath: '/input.txt', scope: 'file', method: 'lzma', level: 1 }]
    }))
  })

  it('submits expert 7Z tuning, a per-file method, and solid mode', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.queryByRole('combobox', { name: 'Compression method / Codec' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: '7Z compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'Automatic (LZMA2 / Copy)' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('combobox', { name: 'Dictionary size' }))
    await user.click(screen.getByRole('option', { name: '64 MB' }))
    await user.click(screen.getByRole('combobox', { name: 'Match finder word size' }))
    await user.click(screen.getByRole('option', { name: '128' }))
    fireEvent.change(screen.getAllByRole('slider').at(-1)!, { target: { value: '96' } })
    await user.click(screen.getByRole('checkbox', { name: /Solid block compression/ }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      sevenZipMethodOverrides: [{ sourcePath: 'C:\\input.txt', scope: 'file', method: 'auto' }],
      dictionarySize: 64 * 1024 * 1024,
      matchFinderWordSize: 128,
      searchCycles: 96,
      solidArchive: true
    }))
  })

  it('configures recursive and per-file 7Z methods in the expert modal', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    const source = { path: '/source', name: 'source', isDirectory: true, size: 4096 }
    const child = { path: '/source/archive.bin', name: 'archive.bin', isDirectory: false, size: 2048 }
    const api = installElectronApi({
      platform: 'macos',
      getDefaultOutputDir: vi.fn().mockResolvedValue('/output'),
      listArchiveInputChildren: vi.fn().mockResolvedValue([child])
    })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[source]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Per-file compression settings' })
    expect(dialog.parentElement).toHaveClass('zip-method-modal--macos')
    expect(dialog.querySelector('.lucide-files')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '7Z compression method for source' }))
      .toHaveTextContent('LZMA2 (High efficiency)')

    await user.click(screen.getByText('/source'))
    await waitFor(() => expect(api.listArchiveInputChildren).toHaveBeenCalledWith('/source'))
    expect(await screen.findByRole('combobox', { name: '7Z compression method for archive.bin' }))
      .toHaveTextContent('LZMA2 (High efficiency)')

    await user.click(screen.getByRole('combobox', { name: '7Z compression method for source' }))
    await user.click(screen.getByRole('option', { name: 'Automatic (LZMA2 / Copy)' }))
    expect(screen.getByRole('combobox', { name: '7Z compression method for archive.bin' }))
      .toHaveTextContent('Automatic (LZMA2 / Copy)')

    await user.click(screen.getByRole('combobox', { name: '7Z compression method for archive.bin' }))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))
    expect(screen.getByRole('combobox', { name: '7Z compression method for source' }))
      .toHaveTextContent('Mixed methods')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('2 overrides')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      sevenZipMethodOverrides: [
        { sourcePath: '/source', scope: 'tree', method: 'auto' },
        { sourcePath: '/source/archive.bin', scope: 'file', method: 'copy' }
      ]
    }))
  })
})
