import React from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArchiveInspector } from './ArchiveInspector'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

/** A listing whose single entry names the archive it came from. */
function listing(name: string) {
  return {
    success: true,
    result: {
      archivePath: `${name}.zip`,
      format: 'ZIP',
      totalFiles: 1,
      totalUncompressedSize: 1,
      totalCompressedSize: 1,
      overallRatio: 0,
      entries: [{ id: name, name: `${name}.txt`, path: `${name}.txt`, isDirectory: false, size: 1 }]
    }
  }
}

const openArchive = () => fireEvent.click(screen.getByRole('button', { name: 'Open file...' }))

// A large archive can take long enough to read that opening a second one
// answers first. Whichever archive was asked for last is the one on screen, so
// the earlier answer has to be dropped rather than take its place.
describe('ArchiveInspector inspection races', () => {
  it('ignores an earlier inspection that answers after a later one', async () => {
    let finishFirst: (value: unknown) => void = () => {}
    const inspectArchive = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce(listing('new'))
    installElectronApi({
      selectFiles: vi.fn()
        .mockResolvedValueOnce(['old.zip'])
        .mockResolvedValueOnce(['new.zip']),
      inspectArchive
    })
    renderWithI18n(<ArchiveInspector />)

    openArchive()
    await waitFor(() => expect(inspectArchive).toHaveBeenCalledTimes(1))
    openArchive()
    await screen.findByText('new.txt')

    await act(async () => { finishFirst(listing('old')) })

    expect(screen.getByText('new.txt')).toBeInTheDocument()
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument()
  })

  it('keeps the newer listing when the earlier inspection fails late', async () => {
    let failFirst: (reason: unknown) => void = () => {}
    const inspectArchive = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject }))
      .mockResolvedValueOnce(listing('new'))
    installElectronApi({
      selectFiles: vi.fn()
        .mockResolvedValueOnce(['old.zip'])
        .mockResolvedValueOnce(['new.zip']),
      inspectArchive
    })
    renderWithI18n(<ArchiveInspector />)

    openArchive()
    await waitFor(() => expect(inspectArchive).toHaveBeenCalledTimes(1))
    openArchive()
    await screen.findByText('new.txt')

    await act(async () => { failFirst(new Error('read failed')) })

    expect(screen.getByText('new.txt')).toBeInTheDocument()
  })

  it('leaves the spinner to the newest inspection', async () => {
    let finishFirst: (value: unknown) => void = () => {}
    let finishSecond: (value: unknown) => void = () => {}
    const inspectArchive = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
    installElectronApi({
      selectFiles: vi.fn()
        .mockResolvedValueOnce(['old.zip'])
        .mockResolvedValueOnce(['new.zip']),
      inspectArchive
    })
    renderWithI18n(<ArchiveInspector />)

    openArchive()
    await waitFor(() => expect(inspectArchive).toHaveBeenCalledTimes(1))
    openArchive()
    await waitFor(() => expect(inspectArchive).toHaveBeenCalledTimes(2))

    // The first answering must not clear the wait the second one is still in.
    await act(async () => { finishFirst(listing('old')) })
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument()

    await act(async () => { finishSecond(listing('new')) })
    expect(await screen.findByText('new.txt')).toBeInTheDocument()
  })
})
