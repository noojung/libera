import React from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithI18n } from './test/render'
import { installElectronApi } from './test/electronApi'
import type { ActiveJob } from './types'

vi.mock('./components/TitleBar', () => ({
  TitleBar: ({ setMode, activeQueueCount }: any) => (
    <div>
      <span data-testid="active-count">{activeQueueCount}</span>
      {['compress', 'extract', 'inspect', 'queue'].map(mode => (
        <button key={mode} onClick={() => setMode(mode)}>{`Mode ${mode}`}</button>
      ))}
    </div>
  )
}))

vi.mock('./components/DropZone', () => ({
  DropZone: ({ items, onAddFiles, allowFolders, validationError }: any) => {
    const extracting = allowFolders === false
    return (
      <div>
        <span data-testid={extracting ? 'extract-count' : 'compress-count'}>{items.length}</span>
        {validationError && <span role="alert">{validationError}</span>}
        {extracting ? (
          <>
            <button onClick={() => onAddFiles(['C:\\one.zip', 'C:\\bad.txt'])}>Add extraction files</button>
            <button onClick={() => onAddFiles(['C:\\one.zip', 'C:\\two.tar'])}>Add two archives</button>
            <button onClick={() => onAddFiles(['C:\\set.z01', 'C:\\set.z02', 'C:\\set.zip'])}>Add a volume set</button>
            <button onClick={() => onAddFiles(['C:\\solo.z01'])}>Add a lone volume</button>
          </>
        ) : (
          <button onClick={() => onAddFiles(['C:\\input.txt'])}>Add compression file</button>
        )}
      </div>
    )
  }
}))

vi.mock('./components/CompressionPanel', () => ({
  CompressionPanel: ({ onStartCompress }: any) => (
    <button onClick={() => onStartCompress({ format: 'zip', level: 6, outputPath: 'C:\\archive.zip' })}>
      Submit compression
    </button>
  )
}))

vi.mock('./components/ExtractionPanel', () => ({
  ExtractionPanel: ({ onStartBatchExtract }: any) => (
    <button onClick={() => onStartBatchExtract({ targetDir: 'C:\\output', createSubfolder: true })}>
      Submit extraction
    </button>
  )
}))

vi.mock('./components/ArchiveInspector', () => ({ ArchiveInspector: () => <div>Inspector content</div> }))

vi.mock('./components/QueueManager', () => ({
  QueueManager: ({ jobs, onCancelJob, onClearCompleted, onOpenFolder }: any) => (
    <div>
      <button onClick={onClearCompleted}>Clear jobs</button>
      {jobs.map((job: ActiveJob) => (
        <div key={job.id} data-testid={`job-${job.id}`}>
          <span>{`${job.sourceName || 'items'}:${job.status}:${job.percent}:${job.errorCode || ''}`}</span>
          {(job.status === 'pending' || job.status === 'running') && (
            <button onClick={() => onCancelJob(job.id)}>{`Cancel ${job.id}`}</button>
          )}
          {job.status === 'completed' && job.outputPath && (
            <button onClick={() => onOpenFolder(job.outputPath!)}>{`Open ${job.id}`}</button>
          )}
        </div>
      ))}
    </div>
  )
}))

vi.mock('./components/PasswordPromptModal', () => ({
  PasswordPromptModal: ({ archiveName, hasIncorrectPassword, onConfirm, onCancel }: any) => (
    <div role="dialog">
      <span>{archiveName}</span>
      {hasIncorrectPassword && <span>Incorrect password</span>}
      <button onClick={() => onConfirm('secret')}>Confirm password</button>
      <button onClick={onCancel}>Cancel password</button>
    </div>
  )
}))

import { App } from './App'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

const statsFor = (paths: string[]) => paths.map(itemPath => ({
  path: itemPath,
  name: itemPath.split('\\').pop()!,
  isDirectory: false,
  size: 100
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('App orchestration', () => {
  it('deduplicates inputs, applies progress, completes compression, and unsubscribes', async () => {
    const result = deferred<any>()
    const unsubscribe = vi.fn()
    let progress!: (data: any) => void
    const compressArchive = vi.fn<(options: any, jobId: string) => Promise<any>>().mockImplementation(() => result.promise)
    const api = installElectronApi({
      onProgress: vi.fn((callback) => { progress = callback; return unsubscribe }),
      getItemStat: vi.fn(async paths => statsFor(paths)),
      compressArchive
    })
    const { user, unmount } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Add compression file' }))
    await user.click(screen.getByRole('button', { name: 'Add compression file' }))
    await waitFor(() => expect(screen.getByTestId('compress-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit compression' }))

    await waitFor(() => expect(api.compressArchive).toHaveBeenCalledOnce())
    const jobId = compressArchive.mock.calls[0][1]
    expect(compressArchive.mock.calls[0][0].inputPaths).toEqual(['C:\\input.txt'])
    act(() => progress({ jobId, processedBytes: 42, totalBytes: 100, percent: 42, phase: 'compressing' }))
    expect(screen.getByTestId(`job-${jobId}`)).toHaveTextContent(':running:42:')

    result.resolve({ success: true, result: { durationMs: 10, originalSize: 100, compressedSize: 50 } })
    await waitFor(() => expect(screen.getByTestId(`job-${jobId}`)).toHaveTextContent(':completed:100:'))
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('records compression failures and clears finished jobs', async () => {
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      compressArchive: vi.fn().mockResolvedValue({ success: false, errorCode: 'insufficientDiskSpace', error: 'full' })
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Add compression file' }))
    await waitFor(() => expect(screen.getByTestId('compress-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit compression' }))
    await waitFor(() => expect(screen.getByText(/:error:0:insufficientDiskSpace/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Clear jobs' }))
    expect(screen.queryByText(/insufficientDiskSpace/)).not.toBeInTheDocument()
    expect(api.compressArchive).toHaveBeenCalledOnce()
  })

  it('filters invalid extraction inputs and extracts multiple archives sequentially', async () => {
    const extractArchive = vi.fn<(options: any, jobId: string) => Promise<any>>()
      .mockResolvedValue({ success: true, result: { durationMs: 5 } })
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      inspectArchive: vi.fn().mockResolvedValue({ success: true, result: { passwordProtected: false } }),
      extractArchive
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Mode extract' }))
    await user.click(screen.getByRole('button', { name: 'Add extraction files' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('1'))
    expect(screen.getByRole('alert')).toHaveTextContent('Folders and unsupported files cannot be added')

    await user.click(screen.getByRole('button', { name: 'Add two archives' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('2'))
    await user.click(screen.getByRole('button', { name: 'Submit extraction' }))
    await waitFor(() => expect(api.extractArchive).toHaveBeenCalledTimes(2))
    expect(extractArchive.mock.calls.map(call => call[0].archivePath)).toEqual(['C:\\one.zip', 'C:\\two.tar'])
    expect(extractArchive.mock.calls.map(call => call[0].targetDir)).toEqual(['C:\\output\\one', 'C:\\output\\two'])
  })

  it('queues one job for a split volume set and extracts it through the final volume', async () => {
    const extractArchive = vi.fn<(options: any, jobId: string) => Promise<any>>()
      .mockResolvedValue({ success: true, result: { durationMs: 5 } })
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      inspectArchive: vi.fn().mockResolvedValue({ success: true, result: { passwordProtected: false } }),
      extractArchive
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Mode extract' }))

    await user.click(screen.getByRole('button', { name: 'Add a volume set' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('1'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // A lone numbered volume is accepted and canonicalized to its set.
    await user.click(screen.getByRole('button', { name: 'Add a lone volume' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('2'))

    await user.click(screen.getByRole('button', { name: 'Submit extraction' }))
    await waitFor(() => expect(api.extractArchive).toHaveBeenCalledTimes(2))
    expect(extractArchive.mock.calls.map(call => call[0].archivePath)).toEqual(['C:\\set.zip', 'C:\\solo.zip'])
  })

  it('retries protected ZIP extraction after a wrong password', async () => {
    const extractArchive = vi.fn<(options: any, jobId: string) => Promise<any>>()
      .mockResolvedValueOnce({ success: false, code: 'WRONG_ZIP_PASSWORD' })
      .mockResolvedValueOnce({ success: true, result: { durationMs: 5 } })
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      inspectArchive: vi.fn().mockResolvedValue({ success: true, result: { passwordProtected: true } }),
      extractArchive
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Mode extract' }))
    await user.click(screen.getByRole('button', { name: 'Add extraction files' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit extraction' }))
    await user.click(await screen.findByRole('button', { name: 'Confirm password' }))
    await screen.findByText('Incorrect password')
    await user.click(screen.getByRole('button', { name: 'Confirm password' }))

    await waitFor(() => expect(api.extractArchive).toHaveBeenCalledTimes(2))
    expect(extractArchive.mock.calls[0][0].password).toBe('secret')
    expect(extractArchive.mock.calls[1][0].password).toBe('secret')
    await waitFor(() => expect(screen.getByText(/one.zip:completed:100:/)).toBeInTheDocument())
  })

  it('marks a protected ZIP as failed when password entry is cancelled', async () => {
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      inspectArchive: vi.fn().mockResolvedValue({ success: true, result: { passwordProtected: true } })
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Mode extract' }))
    await user.click(screen.getByRole('button', { name: 'Add extraction files' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit extraction' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel password' }))

    await waitFor(() => expect(screen.getByText(/one.zip:error:0:passwordCancelled/)).toBeInTheDocument())
    expect(api.extractArchive).not.toHaveBeenCalled()
  })

  it('cancels an active extraction and ignores its later success', async () => {
    const result = deferred<any>()
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      inspectArchive: vi.fn().mockResolvedValue({ success: true, result: { passwordProtected: false } }),
      extractArchive: vi.fn(() => result.promise)
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Mode extract' }))
    await user.click(screen.getByRole('button', { name: 'Add extraction files' }))
    await waitFor(() => expect(screen.getByTestId('extract-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit extraction' }))
    const cancel = await screen.findByRole('button', { name: /^Cancel job-/ })
    await waitFor(() => expect(api.extractArchive).toHaveBeenCalledOnce())
    await user.click(cancel)
    expect(api.cancelJob).toHaveBeenCalledWith(expect.stringMatching(/^job-/))
    expect(screen.getByText(/one.zip:cancelled:/)).toBeInTheDocument()

    result.resolve({ success: true, result: { durationMs: 5 } })
    await waitFor(() => expect(screen.getByText(/one.zip:cancelled:/)).toBeInTheDocument())
  })

  it('cancels an active compression and ignores its later success', async () => {
    const result = deferred<any>()
    const compressArchive = vi.fn<(options: any, jobId: string) => Promise<any>>().mockImplementation(() => result.promise)
    const api = installElectronApi({
      getItemStat: vi.fn(async paths => statsFor(paths)),
      compressArchive
    })
    const { user } = renderWithI18n(<App />)
    await user.click(screen.getByRole('button', { name: 'Add compression file' }))
    await waitFor(() => expect(screen.getByTestId('compress-count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'Submit compression' }))
    const cancel = await screen.findByRole('button', { name: /^Cancel job-/ })
    await waitFor(() => expect(api.compressArchive).toHaveBeenCalledOnce())
    await user.click(cancel)
    expect(api.cancelJob).toHaveBeenCalledWith(expect.stringMatching(/^job-/))
    expect(screen.getByText(/input.txt:cancelled:/)).toBeInTheDocument()

    result.resolve({ success: true, result: { durationMs: 5, originalSize: 100, compressedSize: 50 } })
    await waitFor(() => expect(screen.getByText(/input.txt:cancelled:/)).toBeInTheDocument())
  })
})
