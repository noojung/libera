import React from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueueManager } from './QueueManager'
import { renderWithI18n } from '../test/render'
import type { ActiveJob } from '../types'

function job(overrides: Partial<ActiveJob>): ActiveJob {
  return {
    id: 'job-1',
    type: 'extract',
    sourceName: 'archive.zip',
    itemCount: 1,
    format: 'zip',
    outputPath: 'C:\\output',
    status: 'running',
    phase: 'extracting',
    processedBytes: 512,
    totalBytes: 1024,
    percent: 50,
    startTime: 0,
    ...overrides
  }
}

describe('QueueManager', () => {
  it('renders active progress and delegates cancellation', async () => {
    const onCancel = vi.fn()
    const { user, container } = renderWithI18n(
      <QueueManager jobs={[job({ percent: null, totalBytes: null })]} onOpenFolder={vi.fn()} onClearCompleted={vi.fn()} onCancelJob={onCancel} />
    )
    expect(screen.getByText('Processing')).toBeInTheDocument()
    expect(container.querySelector('.queue-progress__bar--indeterminate')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith('job-1')
    expect(screen.queryByRole('button', { name: 'Open folder' })).not.toBeInTheDocument()
  })

  it('offers cancellation for a running compression job too', async () => {
    const onCancel = vi.fn()
    const { user } = renderWithI18n(
      <QueueManager jobs={[job({ type: 'compress', status: 'pending' })]} onOpenFolder={vi.fn()} onClearCompleted={vi.fn()} onCancelJob={onCancel} />
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith('job-1')
  })

  it('renders determinate progress without an inline style', () => {
    renderWithI18n(
      <QueueManager jobs={[job({ percent: 50 })]} onOpenFolder={vi.fn()} onClearCompleted={vi.fn()} onCancelJob={vi.fn()} />
    )
    const progress = screen.getByRole('progressbar', { name: '50%' })
    expect(progress).toHaveValue(50)
    expect(progress).not.toHaveAttribute('style')
  })

  it('opens completed output and clears finished jobs', async () => {
    const onOpen = vi.fn()
    const onClear = vi.fn()
    const completed = job({ status: 'completed', phase: 'complete', percent: 100, durationMs: 1500 })
    const { user } = renderWithI18n(
      <QueueManager jobs={[completed]} onOpenFolder={onOpen} onClearCompleted={onClear} onCancelJob={vi.fn()} />
    )
    expect(screen.getByText(/Completed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    await user.click(screen.getByRole('button', { name: 'Clear finished jobs' }))
    expect(onOpen).toHaveBeenCalledWith('C:\\output')
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('renders pending, error, and cancelled states with translated errors', () => {
    renderWithI18n(
      <QueueManager
        jobs={[
          job({ id: 'pending', status: 'pending' }),
          job({ id: 'error', status: 'error', errorCode: 'insufficientDiskSpace' }),
          job({ id: 'cancelled', status: 'cancelled' })
        ]}
        onOpenFolder={vi.fn()}
        onClearCompleted={vi.fn()}
        onCancelJob={vi.fn()}
      />
    )
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('not enough disk space')
  })
})
