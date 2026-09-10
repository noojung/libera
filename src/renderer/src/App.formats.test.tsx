import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { renderWithI18n } from './test/render'
import { installElectronApi } from './test/electronApi'

describe('extraction format help', () => {
  it.each(['drop', 'picker'])('clears a rejected drop after a valid %s, including an already selected file', async (method) => {
    installElectronApi({
      selectFiles: vi.fn().mockResolvedValue(['valid.zip']),
      getItemStat: vi.fn(async (paths: string[]) => paths.map(path => ({
        path, name: path, size: 100, isDirectory: false
      })))
    })
    const { user, container } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Extract' }))
    const target = container.querySelector('.drop-zone__target')!
    expect(screen.queryByRole('button', { name: 'Which formats?' })).not.toBeInTheDocument()

    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.drop(target, { dataTransfer: { files: [new File(['text'], 'notes.txt')] } })
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('This archive format is not supported.')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'View supported formats' }))
      expect(screen.getByRole('dialog', { name: 'Supported formats' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Which formats?' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Close' }))
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'OK' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()

      if (method === 'picker') await user.click(screen.getByRole('button', { name: 'Browse files' }))
      else fireEvent.drop(target, { dataTransfer: { files: [new File(['zip'], 'valid.zip')] } })

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Which formats?' })).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByText('valid.zip', { selector: '.drop-zone__item-name' })).toBeInTheDocument()
    }
  })
})
