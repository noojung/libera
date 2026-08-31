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
    await user.click(screen.getByText('Hide the file names too'))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      password: 'secret',
      encryptFileNames: true
    }))
  })

  it('drops the name-hiding option when switching away from 7z', async () => {
    installElectronApi()
    const onStart = vi.fn()
    const { user } = renderWithI18n(
      <CompressionPanel items={[{ path: '/a', name: 'a', isDirectory: false, size: 1 }]} onStartCompress={onStart} />
    )

    await user.click(screen.getByRole('button', { name: '.7Z' }))
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

  it('submits expert ZIP encryption, storage and Deflate tuning', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    expect(screen.getByText(/Expert compression settings/)).toBeInTheDocument()
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'store')
    await user.selectOptions(selects[1], 'rle')
    // Store copies the files verbatim, so the level is pinned at 0.
    expect(screen.getByText('0 - Store')).toBeInTheDocument()
    expect(screen.getAllByRole('slider')[0]).toBeDisabled()

    // The encryption algorithm only appears once a password is being set.
    expect(screen.queryByRole('option', { name: /AES-128/ })).not.toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')
    await user.selectOptions(screen.getAllByRole('combobox').at(-1)!, 'aes128')
    fireEvent.change(screen.getAllByRole('slider').at(-1)!, { target: { value: '9' } })
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      encryptionMethod: 'aes128',
      zipMethod: 'store',
      deflateStrategy: 'rle',
      level: 0,
      memLevel: 9,
      password: 'secret'
    }))
  })

  it('submits expert 7Z codec parameters and solid mode', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'lzma2')
    await user.selectOptions(selects[1], String(64 * 1024 * 1024))
    await user.selectOptions(selects[2], '128')
    fireEvent.change(screen.getAllByRole('slider').at(-1)!, { target: { value: '96' } })
    await user.click(screen.getByRole('checkbox', { name: /Solid block compression/ }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      sevenZipMethod: 'lzma2',
      dictionarySize: 64 * 1024 * 1024,
      matchFinderWordSize: 128,
      searchCycles: 96,
      solidArchive: true
    }))
  })
})
