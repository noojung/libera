import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DropZone } from './DropZone'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

const callbacks = () => ({
  onAddFiles: vi.fn(),
  onRemoveItem: vi.fn(),
  onClearItems: vi.fn(),
  onSelectFilesDialog: vi.fn()
})

describe('DropZone', () => {
  it('opens file and folder dialogs from their controls', async () => {
    installElectronApi()
    const props = callbacks()
    const { user } = renderWithI18n(<DropZone items={[]} {...props} />)

    await user.click(screen.getByRole('button', { name: 'Browse files' }))
    await user.click(screen.getByRole('button', { name: 'Browse folders' }))
    expect(props.onSelectFilesDialog).toHaveBeenNthCalledWith(1, false)
    expect(props.onSelectFilesDialog).toHaveBeenNthCalledWith(2, true)
  })

  it('accepts supported dropped archives and reports rejected files', () => {
    installElectronApi({ getPathForFile: vi.fn((file: File) => `C:\\drop\\${file.name}`) })
    const props = callbacks()
    renderWithI18n(
      <DropZone
        items={[]}
        {...props}
        allowFolders={false}
        acceptedFileExtensions={['.zip', '.tar.gz']}
      />
    )
    const target = screen.getByText(/Drop archive files here/).closest('div')!
    fireEvent.drop(target, {
      dataTransfer: { files: [new File(['zip'], 'valid.ZIP'), new File(['text'], 'notes.txt')] }
    })

    expect(props.onAddFiles).toHaveBeenCalledWith(['C:\\drop\\valid.ZIP'])
    expect(screen.getByRole('alert')).toHaveTextContent('Only ZIP, 7Z, TAR, TAR.GZ, and GZ')
    expect(screen.queryByRole('button', { name: 'Browse folders' })).not.toBeInTheDocument()
  })

  it('renders selected items and delegates remove and clear actions', async () => {
    installElectronApi()
    const props = callbacks()
    const item = { path: 'C:\\data\\one.zip', name: 'one.zip', isDirectory: false, size: 1024 }
    const { user } = renderWithI18n(<DropZone items={[item]} {...props} validationError="Invalid input" />)

    expect(screen.getByText('one.zip')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid input')
    await user.click(screen.getByRole('button', { name: 'Remove one.zip' }))
    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(props.onRemoveItem).toHaveBeenCalledWith(0)
    expect(props.onClearItems).toHaveBeenCalledOnce()
  })
})
