import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompressionPanel } from './CompressionPanel'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

const item = { path: 'C:\\input.txt', name: 'input.txt', isDirectory: false, size: 2048 }

/** An archive-wide row the per-file dialog has taken over: still there, still
 *  labelled, holding no value of its own. */
function levelReadout(): string | null {
  const field = screen.getByText('Compression level').closest('.compression-panel__field')
  return field?.querySelector('.compression-panel__level-value')?.textContent ?? null
}

function expectClearedControl(name: string): void {
  const control = screen.getByRole('combobox', { name })
  expect(control).toBeDisabled()
  expect(control).toHaveTextContent('—')
}

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
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '9' } })
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

  it('resets encryption settings when switching away from 7z', async () => {
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

    // A newly selected format starts from its own encryption defaults.
    await user.click(screen.getByRole('button', { name: '.ZIP' }))
    expect(screen.queryByText('Hide the file names too')).not.toBeInTheDocument()
    expect(screen.queryByText(/Compatibility-focused ZIP encryption/)).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter password')).toHaveValue('')
    expect(screen.getByPlaceholderText('Confirm password')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: 'zip',
      password: undefined,
      encryptionMethod: 'zip20',
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

  it('uses the selected format default instead of carrying the previous level', async () => {
    installElectronApi()
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '9' } })
    expect(screen.getByText('9 - Maximum')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByText('5 - Normal')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('slider'), { target: { value: '5' } })
    expect(screen.getByText('9 - Ultra')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '.GZ' }))
    expect(screen.getByText('6 - Normal')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ format: 'gz', level: 6 }))
  })

  it('resets shared and expert options whenever the format changes', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({
      getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output'),
      selectSaveLocation: vi.fn().mockResolvedValue('D:\\custom.zip')
    })
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={vi.fn()} />)

    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '9' } })
    await user.type(screen.getByPlaceholderText('Enter password'), 'secret')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'secret')
    await user.click(screen.getByRole('combobox', { name: 'Encryption algorithm' }))
    await user.click(screen.getByRole('option', { name: 'AES-128 (WinZip AES 128-bit)' }))
    await user.click(screen.getByRole('checkbox', { name: /Split into volumes/ }))
    await user.click(screen.getByRole('button', { name: '700 MB (CD)' }))
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Click Browse to choose a save location')).toHaveValue('D:\\custom.zip'))
    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('1 override')).toBeInTheDocument()
    expect(levelReadout()).toBe('—')
    expectClearedControl('ZIP compression method')

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByText('5 - Normal')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Enter password')).toHaveValue('')
    expect(screen.getByPlaceholderText('Confirm password')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: /Split into volumes/ })).not.toBeChecked()
    expect(screen.getByPlaceholderText('Click Browse to choose a save location')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Dictionary size' })).toHaveTextContent('16 MB')
    expect(screen.getByRole('combobox', { name: 'Match finder word size' })).toHaveTextContent('32')
    expect(screen.getByText('Search cycles (32)')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Solid block compression/ })).not.toBeChecked()
    expect(screen.queryByText('1 override')).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Dictionary size' }))
    await user.click(screen.getByRole('option', { name: '64 MB' }))
    await user.click(screen.getByRole('checkbox', { name: /Solid block compression/ }))
    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('1 override')).toBeInTheDocument()
    expect(levelReadout()).toBe('—')
    expectClearedControl('Compression method / Codec')

    await user.click(screen.getByRole('button', { name: '.ZIP' }))
    expect(screen.getByText('6 - Normal')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Encryption algorithm' })).toHaveTextContent('ZipCrypto')
    expect(screen.getByPlaceholderText('Enter password')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: /Split into volumes/ })).not.toBeChecked()
    expect(screen.getByPlaceholderText('Click Browse to choose a save location')).toHaveValue('')
    expect(screen.queryByText('1 override')).not.toBeInTheDocument()
    expect(screen.getByText('Compression level')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'ZIP compression method' }))
      .toHaveTextContent('Deflate (8)')

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByRole('combobox', { name: 'Dictionary size' })).toHaveTextContent('16 MB')
    expect(screen.getByRole('checkbox', { name: /Solid block compression/ })).not.toBeChecked()
    expect(screen.queryByText('1 override')).not.toBeInTheDocument()
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
    expect(screen.getByRole('combobox', { name: 'ZIP compression method' }))
      .toHaveTextContent('Deflate (8)')
    expect(screen.getByRole('combobox', { name: 'Deflate strategy' })).toBeInTheDocument()

    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Deflate strategy for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'RLE (Match distance 1 only)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for input.txt' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))
    expect(screen.getByRole('combobox', { name: 'Memory level for input.txt' })).toHaveTextContent('8')
    await user.click(screen.getByRole('combobox', { name: 'Memory level for input.txt' }))
    await user.click(screen.getByRole('option', { name: '3' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(levelReadout()).toBe('—')
    expectClearedControl('ZIP compression method')
    expectClearedControl('Deflate strategy')
    expect(screen.getByText('Memory level (1-9) (—)')).toBeInTheDocument()
    for (const slider of screen.getAllByRole('slider')) expect(slider).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable per-file compression settings' })).toBeChecked()

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
        method: 'deflate',
        deflateStrategy: 'rle',
        memLevel: 3,
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

    expect(screen.getByRole('combobox', { name: 'ZIP compression method' }))
      .toHaveTextContent('Deflate (8)')
    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    expect(screen.queryByRole('combobox', { name: 'Deflate strategy for input.txt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Memory level for input.txt' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(levelReadout()).toBe('—')
    expectClearedControl('ZIP compression method')

    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      zipMethodOverrides: [{ sourcePath: 'C:\\input.txt', scope: 'file', method: 'lzma' }],
      deflateStrategy: undefined,
      memLevel: undefined
    }))
  })

  it('closes the expert card with the per-file dialog for both ZIP and 7Z', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={vi.fn()} />)

    const lastRowOfExpertCard = () =>
      screen.getByText(/Expert compression settings/).closest('.expert-card')!.lastElementChild

    expect(lastRowOfExpertCard())
      .toContainElement(screen.getByRole('button', { name: 'Per-file compression settings' }))

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(lastRowOfExpertCard())
      .toContainElement(screen.getByRole('button', { name: 'Per-file compression settings' }))
  })

  it('resets the archive settings on each per-file toggle while keeping the rules', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '9' } })
    await user.click(screen.getByRole('combobox', { name: 'Deflate strategy' }))
    await user.click(screen.getByRole('option', { name: 'RLE (Match distance 1 only)' }))
    const perFileSwitch = screen.getByRole('switch', { name: 'Enable per-file compression settings' })
    expect(perFileSwitch).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Per-file compression settings' })).toBeDisabled()

    await user.click(perFileSwitch)
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(levelReadout()).toBe('—')
    expectClearedControl('ZIP compression method')

    await user.click(perFileSwitch)

    // The rules the dialog holds survive the trip; the archive-wide strength
    // and tuning do not - both toggles hand them back to the format defaults.
    expect(levelReadout()).toBe('6 - Normal')
    expect(screen.getByRole('combobox', { name: 'ZIP compression method' }))
      .toHaveTextContent('Deflate (8)')
    expect(screen.getByRole('combobox', { name: 'Deflate strategy' }))
      .toHaveTextContent('Default (LZ77 + Huffman)')
    expect(screen.getByText('1 override')).toBeInTheDocument()
    expect(perFileSwitch).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Per-file compression settings' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({
      zipMethodOverrides: undefined,
      deflateStrategy: 'default',
      level: 6
    }))

    await user.click(perFileSwitch)
    expect(levelReadout()).toBe('—')
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({
      zipMethod: undefined,
      zipMethodOverrides: [{ sourcePath: 'C:\\input.txt', scope: 'file', method: 'lzma' }],
      deflateStrategy: undefined
    }))
  })

  it('submits the selected global method while per-file settings are inactive', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('combobox', { name: 'ZIP compression method' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'zip',
      zipMethod: 'lzma',
      zipMethodOverrides: undefined,
      deflateStrategy: undefined,
      memLevel: undefined
    }))

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method / Codec' }))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenLastCalledWith(expect.objectContaining({
      format: '7z',
      level: 0,
      sevenZipMethod: 'copy',
      sevenZipMethodOverrides: undefined,
      dictionarySize: undefined,
      solidArchive: undefined
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

    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Per-file compression settings' })
    expect(dialog.parentElement).toHaveClass('zip-method-modal--macos')
    expect(dialog.querySelector('.lucide-files')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Compression method for source' }))
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for source' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))

    // Opening a folder replaces the listing with its children rather than
    // indenting them underneath, so the folder's own row leaves the screen.
    await user.click(screen.getByRole('button', { name: 'Open source' }))
    await waitFor(() => expect(api.listArchiveInputChildren).toHaveBeenCalledWith('/source'))
    expect(screen.queryByRole('combobox', { name: 'Compression method for source' })).not.toBeInTheDocument()

    expect(await screen.findByRole('combobox', { name: 'Compression strength for photo.jpg' }))
      .toHaveTextContent('9 - Maximum')
    await user.click(await screen.findByRole('combobox', { name: 'Compression method for photo.jpg' }))
    await user.click(screen.getByRole('option', { name: 'Store (0)' }))

    // The breadcrumb walks back up, where the folder now reports both the
    // mixed methods and how many rules it hides.
    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    expect(screen.getByRole('combobox', { name: 'Compression method for source' })).toHaveTextContent('Mixed methods')
    expect(screen.getByText('1 setting inside')).toBeInTheDocument()

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

  it('applies folder tuning to child files without inheritance selections', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    const source = { path: '/source', name: 'source', isDirectory: true, size: 4096 }
    const child = { path: '/source/notes.txt', name: 'notes.txt', isDirectory: false, size: 2048 }
    installElectronApi({
      getDefaultOutputDir: vi.fn().mockResolvedValue('/output'),
      listArchiveInputChildren: vi.fn().mockResolvedValue([child])
    })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[source]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    expect(screen.getByRole('combobox', { name: 'Compression method for source' }))
      .toHaveTextContent('Deflate (8)')
    expect(screen.queryByText(/Inherit/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Deflate strategy for source' }))
    await user.click(screen.getByRole('option', { name: 'RLE (Match distance 1 only)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for source' }))
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))
    await user.click(screen.getByRole('combobox', { name: 'Memory level for source' }))
    await user.click(screen.getByRole('option', { name: '4' }))

    await user.click(screen.getByRole('button', { name: 'Open source' }))
    await screen.findByRole('combobox', { name: 'Compression method for notes.txt' })
    expect(screen.getByRole('combobox', { name: 'Deflate strategy for notes.txt' }))
      .toHaveTextContent('RLE (Match distance 1 only)')
    expect(screen.getByRole('combobox', { name: 'Compression strength for notes.txt' }))
      .toHaveTextContent('9 - Maximum')
    expect(screen.getByRole('combobox', { name: 'Memory level for notes.txt' }))
      .toHaveTextContent('4')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      zipMethodOverrides: [{
        sourcePath: '/source',
        scope: 'tree',
        method: 'deflate',
        deflateStrategy: 'rle',
        memLevel: 4,
        level: 9
      }]
    }))
  })

  it('keeps Store at level zero while a forced codec takes the minimum', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('/output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[{ ...item, path: '/input.txt' }]} onStartCompress={onStart} />)

    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '0' } })
    // Deflate cannot sit at zero, so the slider reads back as the minimum
    // until Store is the method that was asked for.
    expect(levelReadout()).toBe('1 - Fastest')
    await user.click(screen.getByRole('combobox', { name: 'ZIP compression method' }))
    await user.click(screen.getByRole('option', { name: 'Store (0)' }))
    expect(levelReadout()).toBe('0 - Store')
    expect(screen.getAllByRole('slider')[0]).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      level: 0,
      zipMethod: 'store',
      zipMethodOverrides: undefined
    }))
  })

  it('submits expert 7Z tuning, a per-file method, and solid mode', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))
    expect(screen.getByRole('combobox', { name: 'Compression method / Codec' }))
      .toHaveTextContent('LZMA2 (High efficiency)')
    await user.click(screen.getByRole('combobox', { name: 'Dictionary size' }))
    await user.click(screen.getByRole('option', { name: '64 MB' }))
    await user.click(screen.getByRole('combobox', { name: 'Match finder word size' }))
    await user.click(screen.getByRole('option', { name: '128' }))
    fireEvent.change(screen.getAllByRole('slider').at(-1)!, { target: { value: '96' } })
    await user.click(screen.getByRole('checkbox', { name: /Solid block compression/ }))

    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for input.txt' }))
    await user.click(screen.getByRole('option', { name: 'LZMA2 (High efficiency)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for input.txt' }))
    await user.click(screen.getByRole('option', { name: '9 - Ultra' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))

    expect(levelReadout()).toBe('—')
    expectClearedControl('Compression method / Codec')
    expectClearedControl('Dictionary size')
    expectClearedControl('Match finder word size')
    expect(screen.getByText('Search cycles (—)')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Solid block compression/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: /Start compression/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      sevenZipMethod: undefined,
      sevenZipMethodOverrides: [{ sourcePath: 'C:\\input.txt', scope: 'file', method: 'lzma2', level: 9 }],
      dictionarySize: undefined,
      matchFinderWordSize: undefined,
      searchCycles: undefined,
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
    await user.click(screen.getByRole('switch', { name: 'Enable per-file compression settings' }))
    await user.click(screen.getByRole('button', { name: 'Per-file compression settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Per-file compression settings' })
    expect(dialog.parentElement).toHaveClass('zip-method-modal--macos')
    expect(dialog.querySelector('.lucide-files')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Compression method for source' }))
      .toHaveTextContent('LZMA2 (High efficiency)')
    expect(screen.getByRole('combobox', { name: 'Compression strength for source' }))
      .toHaveTextContent('5 - Normal')

    // Drilling in shows the archive defaults reaching the child untouched.
    await user.click(screen.getByRole('button', { name: 'Open source' }))
    await waitFor(() => expect(api.listArchiveInputChildren).toHaveBeenCalledWith('/source'))
    expect(await screen.findByRole('combobox', { name: 'Compression method for archive.bin' }))
      .toHaveTextContent('LZMA2 (High efficiency)')
    expect(screen.getByRole('combobox', { name: 'Compression strength for archive.bin' }))
      .toHaveTextContent('5 - Normal')

    // Walking back up to set a folder rule, then down again to see it cascade.
    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression method for source' }))
    await user.click(screen.getByRole('option', { name: 'LZMA2 (High efficiency)' }))
    await user.click(screen.getByRole('combobox', { name: 'Compression strength for source' }))
    await user.click(screen.getByRole('option', { name: '9 - Ultra' }))

    await user.click(screen.getByRole('button', { name: 'Open source' }))
    expect(await screen.findByRole('combobox', { name: 'Compression method for archive.bin' }))
      .toHaveTextContent('LZMA2 (High efficiency)')
    expect(screen.getByRole('combobox', { name: 'Compression strength for archive.bin' }))
      .toHaveTextContent('9 - Ultra')

    await user.click(screen.getByRole('combobox', { name: 'Compression method for archive.bin' }))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))
    expect(screen.queryByRole('combobox', { name: 'Compression strength for archive.bin' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    expect(screen.getByRole('combobox', { name: 'Compression method for source' }))
      .toHaveTextContent('Mixed methods')

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('2 overrides')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Start compression/ }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      format: '7z',
      sevenZipMethodOverrides: [
        { sourcePath: '/source', scope: 'tree', method: 'lzma2', level: 9 },
        { sourcePath: '/source/archive.bin', scope: 'file', method: 'copy' }
      ]
    }))
  })
})
