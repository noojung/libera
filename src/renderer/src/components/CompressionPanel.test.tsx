import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CompressionPanel } from './CompressionPanel'
import { renderWithI18n } from '../test/render'
import { installElectronApi } from '../test/electronApi'

const item = { path: 'C:\\input.txt', name: 'input.txt', isDirectory: false, size: 2048 }

describe('CompressionPanel', () => {
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
    await user.click(screen.getByRole('checkbox', { name: 'Split into volumes' }))
    await user.click(screen.getByRole('button', { name: '700 MB (CD)' }))
    await user.click(screen.getByRole('button', { name: 'Start compression 🚀' }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ splitSize: 700 * 1024 * 1024 }))
  })

  it('rejects a custom split size below the minimum volume', async () => {
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<CompressionPanel items={[item]} onStartCompress={onStart} />)
    await user.click(screen.getByRole('checkbox', { name: 'Split into volumes' }))
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
    expect(onStart).toHaveBeenCalledWith({ format: 'zip', level: 9, outputPath: 'D:\\secure.zip', password: 'secret', splitSize: undefined })
  })

  it('hides password inputs for formats that cannot encrypt, and disables empty jobs', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Start compression 🚀' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '.TAR' }))
    expect(screen.queryByPlaceholderText('Enter password')).not.toBeInTheDocument()
  })

  it('offers split but not a password for 7z, which cannot be created encrypted', async () => {
    installElectronApi()
    const { user } = renderWithI18n(<CompressionPanel items={[]} onStartCompress={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '.7Z' }))

    expect(screen.getByText('Split into volumes')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Enter password')).not.toBeInTheDocument()
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
})
