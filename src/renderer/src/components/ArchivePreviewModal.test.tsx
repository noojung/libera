import React from 'react'
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArchivePreviewModal } from './ArchivePreviewModal'
import { detectLineEnding } from '@/utils/lineEndings'
import type { ArchivePreviewResult } from '@services/archivePreview'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'

function textResult(text: string): ArchivePreviewResult {
  return {
    kind: 'text',
    text,
    encoding: 'utf-8',
    truncated: false,
    previewedBytes: Buffer.byteLength(text),
    totalBytes: Buffer.byteLength(text),
    rawBytes: new TextEncoder().encode(text)
  }
}

function show(text: string, expert = true): void {
  localStorage.setItem('libera_expert_mode', expert ? 'true' : 'false')
  installElectronApi()
  renderWithI18n(
    <ArchivePreviewModal
      entryPath="notes.txt"
      loading={false}
      result={textResult(text)}
      errorKey={null}
      onClose={vi.fn()}
    />
  )
}

afterEach(() => {
  localStorage.clear()
})

describe('detectLineEnding', () => {
  it.each([
    ['unix', 'first\nsecond\nthird', 'lf'],
    ['windows', 'first\r\nsecond\r\nthird', 'crlf'],
    ['classic mac', 'first\rsecond\rthird', 'cr'],
    ['both kinds', 'first\r\nsecond\nthird', 'mixed'],
    ['a single line', 'no break at all', 'none'],
    ['a trailing break', 'one line\n', 'lf']
  ])('reads %s line endings', (_, text, expected) => {
    expect(detectLineEnding(text)).toBe(expected)
  })

  // The CR of a CRLF pair must not also count as a lone CR, or every Windows
  // file would read as mixed.
  it('does not mistake CRLF for a CR and an LF', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toBe('crlf')
    expect(detectLineEnding('a\r\nb\rc')).toBe('mixed')
  })
})

describe('ArchivePreviewModal', () => {
  it('names the views without repeating the word view', () => {
    show('hello\n')

    expect(screen.getByRole('button', { name: 'Text' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hex' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Text View/ })).not.toBeInTheDocument()
  })

  it('reports the line endings alongside the encoding', () => {
    show('first\r\nsecond\r\n')

    expect(screen.getByText('Encoding: UTF-8')).toBeInTheDocument()
    expect(screen.getByText('Line endings: CRLF')).toBeInTheDocument()
  })

  // The footer spaces its children apart to keep the truncation notice on the
  // right, which would strand the line endings there too.
  it('keeps the line endings beside the encoding', () => {
    show('first\r\nsecond\r\n')

    const meta = screen.getByText('Encoding: UTF-8').parentElement
    expect(meta).toHaveClass('archive-preview__meta')
    expect(meta).toContainElement(screen.getByText('Line endings: CRLF'))
  })

  it('spells out a file that mixes them', () => {
    show('first\r\nsecond\n')

    expect(screen.getByText('Line endings: Mixed (CRLF + LF)')).toBeInTheDocument()
  })

  it('reports line endings outside expert mode too', () => {
    show('only one line', false)

    expect(screen.getByText('Line endings: None')).toBeInTheDocument()
  })
})
