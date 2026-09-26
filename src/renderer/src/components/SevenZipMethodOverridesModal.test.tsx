import React, { useState } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SevenZipCompressionLevel, SevenZipMethodOverride, SevenZipSolidBlock } from '@services/compressor'
import type { SelectedItem } from '@/types'
import { SevenZipMethodOverridesModal } from './SevenZipMethodOverridesModal'
import { installElectronApi } from '@/test/electronApi'
import { renderWithI18n } from '@/test/render'

const photos: SelectedItem = { path: 'C:\\Work\\photos', name: 'photos', isDirectory: true, size: 0 }
const notes: SelectedItem = { path: 'C:\\Work\\notes.txt', name: 'notes.txt', isDirectory: false, size: 2048 }

/** Holds the rules the way the panel does, so each change feeds the next render. */
function renderModal({
  items = [photos, notes],
  overrides = [],
  defaultLevel = 5,
  solid = false,
  filterPattern,
  onClose = vi.fn()
}: {
  items?: SelectedItem[]
  overrides?: SevenZipMethodOverride[]
  defaultLevel?: SevenZipCompressionLevel
  solid?: boolean
  filterPattern?: string
  onClose?: () => void
} = {}) {
  const onChange = vi.fn()
  const Harness = () => {
    const [rules, setRules] = useState(overrides)
    return (
      <SevenZipMethodOverridesModal
        items={items}
        overrides={rules}
        defaultLevel={defaultLevel}
        outputPath={'C:\\Out\\archive.7z'}
        solid={solid}
        excludeSymlinks={false}
        excludeMacMetadata
        excludeHiddenFiles={false}
        filterPattern={filterPattern}
        onChange={next => { onChange(next); setRules(next) }}
        onClose={onClose}
      />
    )
  }
  const rendered = renderWithI18n(<Harness />)
  const latest = (): SevenZipMethodOverride[] => onChange.mock.lastCall?.[0]
  return { ...rendered, onChange, latest }
}

const method = (name: string) => screen.getByRole('combobox', { name: `Compression method for ${name}` })
const level = (name: string) => screen.queryByRole('combobox', { name: `Compression strength for ${name}` })
const blocksToggle = () => screen.getByRole('button', { name: 'Solid block preview' })

const block = (method: SevenZipSolidBlock['method'], paths: string[], dictionarySize?: number): SevenZipSolidBlock => ({
  method,
  dictionarySize,
  entries: paths.map(path => ({ path, size: 1024 })),
  totalBytes: paths.length * 1024
})

describe('SevenZipMethodOverridesModal', () => {
  it('starts every selected item on LZMA2 at the archive strength', () => {
    installElectronApi()
    renderModal({ defaultLevel: 9 })

    expect(screen.getByRole('dialog', { name: 'Per-file compression settings' })).toBeInTheDocument()
    expect(method('notes.txt')).toHaveTextContent('LZMA2 (High efficiency)')
    expect(level('notes.txt')).toHaveTextContent('9 - Ultra')
    expect(screen.getByText('0 overrides')).toBeInTheDocument()
  })

  it('offers only the five levels 7-Zip names', async () => {
    installElectronApi()
    const { user } = renderModal()

    await user.click(level('notes.txt')!)
    expect(screen.getAllByRole('option').map(option => option.textContent))
      .toEqual(['1 - Fastest', '3 - Fast', '5 - Normal', '7 - Maximum', '9 - Ultra'])
  })

  it('drops the strength from a rule switched to Copy', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'lzma2', level: 9, dictionarySize: 1 << 20 }]
    })

    await user.click(method('notes.txt'))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))

    expect(latest()).toEqual([{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'copy' }])
    expect(level('notes.txt')).toBeNull()
  })

  it('keeps the tuning of a rule switched back to LZMA2', async () => {
    installElectronApi()
    const tuned = { level: 7 as const, dictionarySize: 1 << 22, matchFinderWordSize: 64 as const, searchCycles: 48 }
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'lzma2', ...tuned }]
    })

    await user.click(method('photos'))
    await user.click(screen.getByRole('option', { name: 'LZMA2 (High efficiency)' }))

    expect(latest()).toEqual([{ sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'lzma2', ...tuned }])
  })

  it('reports a folder whose children disagree, and replaces them when it takes a method', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'copy' }]
    })

    expect(method('photos')).toHaveTextContent('Mixed methods')
    expect(level('photos')).toBeNull()
    expect(screen.getByText('1 setting inside')).toBeInTheDocument()

    await user.click(method('photos'))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))
    expect(latest()).toEqual([{ sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'copy' }])
    expect(screen.queryByText('1 setting inside')).not.toBeInTheDocument()
  })

  it('takes the strength off the rules inside a folder given one of its own', async () => {
    installElectronApi()
    const { user, latest } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'lzma2', level: 1 }]
    })

    expect(level('photos')).toHaveTextContent('Mixed strengths')
    await user.click(level('photos')!)
    await user.click(screen.getByRole('option', { name: '9 - Ultra' }))

    expect(latest()).toEqual([
      { sourcePath: 'C:\\Work\\photos\\raw.dng', scope: 'file', method: 'lzma2' },
      { sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'lzma2', level: 9 }
    ])
  })

  it('opens a folder whose children inherit its rule', async () => {
    const api = installElectronApi({
      listArchiveInputChildren: vi.fn().mockResolvedValue([
        { path: 'C:\\Work\\photos\\cat.jpg', name: 'cat.jpg', isDirectory: false, size: 10 }
      ])
    })
    const { user } = renderModal({
      overrides: [{ sourcePath: 'C:\\Work\\photos', scope: 'tree', method: 'lzma2', level: 1 }]
    })

    await user.click(screen.getByRole('button', { name: 'Open photos' }))
    expect(api.listArchiveInputChildren).toHaveBeenCalledWith('C:\\Work\\photos')
    expect(await screen.findByText('cat.jpg')).toBeInTheDocument()
    expect(level('cat.jpg')).toHaveTextContent('1 - Fastest')

    await user.click(screen.getByRole('button', { name: 'All selected items' }))
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
  })

  it('says so when a folder cannot be read', async () => {
    installElectronApi({ listArchiveInputChildren: vi.fn().mockRejectedValue(new Error('EACCES')) })
    const { user } = renderModal()

    await user.click(screen.getByRole('button', { name: 'Open photos' }))
    expect(await screen.findByText('This folder could not be read.')).toBeInTheDocument()
  })

  it('leaves the block preview off, and asks for no plan, when solid mode is off', async () => {
    const api = installElectronApi()
    renderModal({ solid: false })

    expect(blocksToggle()).toBeDisabled()
    expect(blocksToggle()).toHaveTextContent('Solid block compression is off')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(api.planSevenZipSolidBlocks).not.toHaveBeenCalled()
  })

  it('plans the blocks from what the writer would take and counts lone streams apart', async () => {
    const api = installElectronApi({
      planSevenZipSolidBlocks: vi.fn().mockResolvedValue([
        block('lzma2', ['photos/a.jpg', 'photos/b.jpg'], 1 << 20),
        block('copy', ['notes.txt'])
      ])
    })
    const { user } = renderModal({ solid: true, filterPattern: '*.jpg' })

    expect(blocksToggle()).toHaveTextContent('Reading the inputs…')
    await waitFor(() => expect(blocksToggle()).toHaveTextContent('1 block · 1 standalone file'))
    expect(api.planSevenZipSolidBlocks).toHaveBeenCalledTimes(1)
    expect(api.planSevenZipSolidBlocks).toHaveBeenCalledWith({
      inputPaths: ['C:\\Work\\photos', 'C:\\Work\\notes.txt'],
      outputPath: 'C:\\Out\\archive.7z',
      level: 5,
      methodOverrides: [],
      solid: true,
      excludeSymlinks: false,
      excludeMacMetadata: true,
      excludeHiddenFiles: false,
      filterPattern: '*.jpg'
    })

    await user.click(blocksToggle())
    expect(blocksToggle()).toHaveAttribute('aria-expanded', 'true')
    const head = screen.getByRole('button', { name: /Block 1/ })
    expect(head).toHaveTextContent('2 files · 2 KiB · 1 MiB dictionary')
    expect(screen.queryByText('a.jpg')).not.toBeInTheDocument()

    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    expect(screen.getAllByText('photos/')).toHaveLength(2)

    const standalone = screen.getByText('Standalone files').parentElement!
    expect(within(standalone).getByText('notes.txt')).toBeInTheDocument()
    expect(within(standalone).getByText('Copy')).toBeInTheDocument()
  })

  it('plans again when a rule changes', async () => {
    const api = installElectronApi()
    const { user } = renderModal({ solid: true })

    await waitFor(() => expect(blocksToggle()).toHaveTextContent('No file carries data'))
    await user.click(method('notes.txt'))
    await user.click(screen.getByRole('option', { name: 'Copy (No compression)' }))

    await waitFor(() => expect(api.planSevenZipSolidBlocks).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.planSevenZipSolidBlocks).mock.lastCall?.[0].methodOverrides)
      .toEqual([{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'copy' }])
  })

  it('names the case where no two files share a block', async () => {
    installElectronApi({ planSevenZipSolidBlocks: vi.fn().mockResolvedValue([block('lzma2', ['notes.txt'])]) })
    renderModal({ solid: true })
    await waitFor(() => expect(blocksToggle()).toHaveTextContent('No files share a block · 1 standalone file'))
  })

  it('reports a plan that could not be read', async () => {
    installElectronApi({ planSevenZipSolidBlocks: vi.fn().mockRejectedValue(new Error('EACCES')) })
    renderModal({ solid: true })
    await waitFor(() => expect(blocksToggle()).toHaveTextContent('The blocks could not be read'))
  })

  it('resets every rule and closes on each way out', async () => {
    installElectronApi()
    const onClose = vi.fn()
    const { user, latest, container } = renderModal({
      onClose,
      overrides: [{ sourcePath: 'C:\\Work\\notes.txt', scope: 'file', method: 'copy' }]
    })

    await user.click(screen.getByRole('button', { name: /Reset all/ }))
    expect(latest()).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Close per-file compression settings' }))
    fireEvent.mouseDown(container.querySelector('.zip-method-modal')!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(4)
  })
})
