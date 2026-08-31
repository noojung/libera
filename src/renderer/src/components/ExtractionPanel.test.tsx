import React from 'react'
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtractionPanel } from './ExtractionPanel'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

const archive = { path: 'C:\\in\\archive.zip', name: 'archive.zip', isDirectory: false, size: 1024 }

describe('ExtractionPanel', () => {
  beforeEach(() => {
    localStorage.removeItem('libera_expert_mode')
  })

  it('loads the default directory and starts extraction with current options', async () => {
    installElectronApi({ getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<ExtractionPanel items={[archive]} onStartBatchExtract={onStart} />)
    const pathInput = screen.getByPlaceholderText('Choose an extraction path')
    await waitFor(() => expect(pathInput).toHaveValue('C:\\output'))

    await user.click(screen.getByText('Create a subfolder for each archive'))
    await user.click(screen.getByRole('button', { name: 'Start extraction 🚀' }))
    expect(onStart).toHaveBeenCalledWith({ targetDir: 'C:\\output', createSubfolder: false })
  })

  it('selects a destination and disables extraction without inputs', async () => {
    const api = installElectronApi({ selectExtractFolder: vi.fn().mockResolvedValue('D:\\chosen') })
    const { user, rerender } = renderWithI18n(<ExtractionPanel items={[archive]} onStartBatchExtract={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Choose an extraction path')).toHaveValue('D:\\chosen'))
    expect(api.selectExtractFolder).toHaveBeenCalledWith('Select extraction destination folder')

    rerender(<ExtractionPanel items={[]} onStartBatchExtract={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Start extraction 🚀' })).toBeDisabled()
  })

  it('submits encoding, overwrite, filtering and restoration controls in expert mode', async () => {
    localStorage.setItem('libera_expert_mode', 'true')
    installElectronApi({ platform: 'macos', getDefaultOutputDir: vi.fn().mockResolvedValue('C:\\output') })
    const onStart = vi.fn()
    const { user } = renderWithI18n(<ExtractionPanel items={[archive]} onStartBatchExtract={onStart} />)
    await waitFor(() => expect(screen.getByPlaceholderText('Choose an extraction path')).toHaveValue('C:\\output'))

    await user.click(screen.getByRole('combobox', { name: 'Filename character encoding' }))
    await user.click(screen.getByRole('option', { name: 'Korean Windows (CP949 / EUC-KR)' }))
    await user.click(screen.getByRole('combobox', { name: 'File overwrite rule' }))
    await user.click(screen.getByRole('option', { name: 'Skip existing files' }))
    await user.click(screen.getByRole('checkbox', { name: /Restore Unix file permissions/ }))
    await user.click(screen.getByRole('checkbox', { name: /Restore symbolic links/ }))
    await user.click(screen.getByRole('checkbox', { name: /Filter out macOS metadata/ }))
    await user.type(screen.getByPlaceholderText(/\*\.txt/), '*.txt, !secret*')
    await user.click(screen.getByRole('button', { name: /Start extraction/ }))

    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      encoding: 'cp949',
      overwritePolicy: 'skip',
      restoreTimestamps: true,
      restorePermissions: false,
      restoreSymlinks: true,
      excludeMacMetadata: true,
      strictCrc: true,
      filterPattern: '*.txt, !secret*'
    }))
  })
})
