import React, { useState } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ZipMethodOverride } from '@services/compressor'
import type { SelectedItem } from '@/types'
import { ZipMethodOverridesModal } from './ZipMethodOverridesModal'
import { installElectronApi } from '@/test/electronApi'
import { renderWithI18n } from '@/test/render'

const photos: SelectedItem = { path: 'C:\\Work\\photos', name: 'photos', isDirectory: true, size: 0 }
const notes: SelectedItem = { path: 'C:\\Work\\notes.txt', name: 'notes.txt', isDirectory: false, size: 2048 }

/** Holds the rules the way the panel does, so each change feeds the next render. */
function renderModal({
  items = [photos, notes],
  overrides = [],
  defaultLevel = 6,
  onClose = vi.fn()
}: {
  items?: SelectedItem[]
  overrides?: ZipMethodOverride[]
  defaultLevel?: number
  onClose?: () => void
} = {}) {
  const onChange = vi.fn()
  const Harness = () => {
    const [rules, setRules] = useState(overrides)
    return (
      <ZipMethodOverridesModal
        items={items}
        overrides={rules}
        defaultLevel={defaultLevel}
        onChange={next => { onChange(next); setRules(next) }}
        onClose={onClose}
      />
    )
  }
  const rendered = renderWithI18n(<Harness />)
  /** The rules as the modal last reported them. */
  const latest = (): ZipMethodOverride[] => onChange.mock.lastCall?.[0]
  return { ...rendered, onChange, latest }
}

const control = (label: string, name: string) => screen.getByRole('combobox', { name: `${label} for ${name}` })
const method = (name: string) => control('Compression method', name)
const strategy = (name: string) => screen.queryByRole('combobox', { name: `Deflate strategy for ${name}` })
const level = (name: string) => screen.queryByRole('combobox', { name: `Compression strength for ${name}` })
const memory = (name: string) => screen.queryByRole('combobox', { name: `Memory level for ${name}` })

describe('ZipMethodOverridesModal', () => {
  it('starts every selected item on Deflate at the archive strength', () => {
    installElectronApi()
    renderModal({ defaultLevel: 9 })

    expect(screen.getByRole('dialog', { name: 'Per-file compression settings' })).toBeInTheDocument()
    expect(screen.getByText('C:\\Work\\notes.txt')).toBeInTheDocument()
    expect(screen.getByText('2 KiB')).toBeInTheDocument()
    expect(method('notes.txt')).toHaveTextContent('Deflate (8)')
    expect(strategy('notes.txt')).toHaveTextContent('Default (LZ77 + Huffman)')
    expect(level('notes.txt')).toHaveTextContent('9 - Maximum')
    expect(memory('notes.txt')).toHaveTextContent('8')
    expect(screen.getByText('0 overrides')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reset all/ })).toBeDisabled()
  })

  it('asks for items when nothing is selected', () => {
    installElectronApi()
    renderModal({ items: [] })
    expect(screen.getByText('Choose files or folders to compress first! 🐾')).toBeInTheDocument()
  })

  it('writes a file rule and hides the settings Store has no use for', async () => {
    installElectronApi()
    const { user, latest } = renderModal()

    await user.click(method('notes.txt'))
    await user.click(screen.getByRole('option', { name: 'Store (0)' }))

    expect(latest()).toEqual([{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'store' }])
    expect(strategy('notes.txt')).toBeNull()
    expect(level('notes.txt')).toBeNull()
    expect(memory('notes.txt')).toBeNull()
    expect(screen.getByText('1 override')).toBeInTheDocument()
  })

  it('keeps Deflate-only settings off a rule for another method', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'deflate', deflateStrategy: 'rle', memLevel: 3, level: 2 }]
    })

    await user.click(method('notes.txt'))
    await user.click(screen.getByRole('option', { name: 'Zstandard (93)' }))

    expect(latest()).toEqual([{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'zstd', level: 2 }])
    expect(strategy('notes.txt')).toBeNull()
    expect(memory('notes.txt')).toBeNull()
    expect(level('notes.txt')).toHaveTextContent('2')
  })

  it('sets the strength, strategy and memory level of one file', async () => {
    installElectronApi()
    const { user, latest } = renderModal()

    await user.click(level('notes.txt')!)
    await user.click(screen.getByRole('option', { name: '1 - Fastest' }))
    await user.click(strategy('notes.txt')!)
    await user.click(screen.getByRole('option', { name: 'Filtered (Long matches only)' }))
    await user.click(memory('notes.txt')!)
    await user.click(screen.getByRole('option', { name: '9' }))

    expect(latest()).toEqual([{
      sourcePath: 'C:\\Work\\notes.txt',
      scope: 'file',
      method: 'deflate',
      deflateStrategy: 'filtered',
      level: 1,
      memLevel: 9
    }])
  })

  it('reports a folder whose children disagree as mixed', () => {
    installElectronApi()
    renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'store' }]
    })

    expect(method('photos')).toHaveTextContent('Mixed methods')
    expect(strategy('photos')).toBeNull()
    expect(level('photos')).toBeNull()
    expect(screen.getByText('1 setting inside')).toBeInTheDocument()
  })

  it('replaces every rule inside a folder when the folder takes a method', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [
        { sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'store' },
        { sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'store' }
      ]
    })

    await user.click(method('photos'))
    expect(screen.getByRole('option', { name: 'Mixed methods' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('option', { name: 'LZMA (14)' }))

    expect(latest()).toEqual([
      { sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'store' },
      { sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'lzma' }
    ])
    expect(method('photos')).toHaveTextContent('LZMA (14)')
  })

  it('takes the strength off the rules inside a folder given one of its own', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'deflate', level: 1 }]
    })

    expect(level('photos')).toHaveTextContent('Mixed strengths')
    await user.click(level('photos')!)
    await user.click(screen.getByRole('option', { name: '9 - Maximum' }))

    expect(latest()).toEqual([
      { sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'deflate' },
      { sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'deflate', level: 9 }
    ])
  })

  it('opens a folder whose children inherit its rule, and walks back up', async () => {
    const api = installElectronApi({
      listArchiveInputChildren: vi.fn().mockResolvedValue([
        { path: 'C:\\Work\\photos\\raw', name: 'raw', isDirectory: true, size: 0 },
        { path: 'C:\\Work\\photos\\cat.jpg', name: 'cat.jpg', isDirectory: false, size: 10 }
      ])
    })
    const { user } = renderModal({
      // A different case on Windows is still the same folder.
      overrides: [{ sourcePath: 'c:/work/PHOTOS', scope: 'tree', method: 'store' }]
    })

    await user.click(screen.getByRole('button', { name: 'Open photos' }))
    expect(api.listArchiveInputChildren).toHaveBeenCalledWith('C:\\Work\\photos')
    expect(await screen.findByText('cat.jpg')).toBeInTheDocument()
    expect(method('cat.jpg')).toHaveTextContent('Store (0)')
    // Inside a folder the breadcrumb says where, and folders have no size.
    expect(screen.queryByText('C:\\Work\\photos\\cat.jpg')).not.toBeInTheDocument()
    expect(screen.getByText('—', { selector: '.zip-method-modal__entry-size' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'photos' })).toHaveClass('is-active')

    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    expect(screen.getByText('notes.txt')).toBeInTheDocument()

    // A folder already read is not read again.
    await user.click(screen.getByRole('button', { name: 'Open photos' }))
    expect(await screen.findByText('cat.jpg')).toBeInTheDocument()
    expect(api.listArchiveInputChildren).toHaveBeenCalledTimes(1)
  })

  it('says so when a folder cannot be read, or holds nothing', async () => {
    installElectronApi({
      listArchiveInputChildren: vi.fn()
        .mockRejectedValueOnce(new Error('EACCES'))
        .mockResolvedValueOnce([])
    })
    const empty: SelectedItem = { path: 'C:\\Work\\empty', name: 'empty', isDirectory: true, size: 0 }
    const { user } = renderModal({ items: [photos, empty] })

    await user.click(screen.getByRole('button', { name: 'Open photos' }))
    expect(await screen.findByText('This folder could not be read.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    await user.click(screen.getByRole('button', { name: 'Open empty' }))
    expect(await screen.findByText('This folder has no compressible files.')).toBeInTheDocument()
  })

  // Only Windows folds case; elsewhere `Photos` and `photos` are two folders.
  it('matches rule paths case-sensitively off Windows', () => {
    installElectronApi({ platform: 'macos' })
    renderModal({
      items: [{ path: '/work/photos', name: 'photos', isDirectory: true, size: 0 }],
      overrides: [{ sourcePath: '/work/Photos/raw.dng', scope: 'file', method: 'store' }]
    })
    expect(method('photos')).toHaveTextContent('Deflate (8)')
    expect(screen.queryByText('1 setting inside')).not.toBeInTheDocument()
  })

  it('resets every rule', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'store' }]
    })

    await user.click(screen.getByRole('button', { name: /Reset all/ }))
    expect(latest()).toEqual([])
    await waitFor(() => expect(screen.getByRole('button', { name: /Reset all/ })).toBeDisabled())
  })

  it('closes on Done, the close button, the backdrop and Escape', async () => {
    installElectronApi()
    const onClose = vi.fn()
    const { user, container } = renderModal({ onClose })

    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Close per-file compression settings' }))
    fireEvent.mouseDown(container.querySelector('.zip-method-modal')!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(4)

    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(4)
  })
})
