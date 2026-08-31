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
  showResult(textResult(text), 'notes.txt', expert)
}

function showResult(result: ArchivePreviewResult, entryPath: string, expert = true): void {
  localStorage.setItem('libera_expert_mode', expert ? 'true' : 'false')
  installElectronApi()
  renderWithI18n(
    <ArchivePreviewModal
      entryPath={entryPath}
      loading={false}
      result={result}
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

  // A hex dump of a PNG tells you nothing you wanted from a picture, so the
  // view belongs to text entries alone.
  it('does not offer hex for an image', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    showResult(
      {
        kind: 'image',
        data,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        previewedBytes: data.length,
        totalBytes: data.length
      },
      'logo.png'
    )

    expect(screen.queryByRole('button', { name: 'Hex' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Image View' })).not.toBeInTheDocument()
  })

  it('reports the line endings alongside the encoding', () => {
    show('first\r\nsecond\r\n')

    expect(screen.getByText('Encoding: UTF-8')).toBeInTheDocument()
    expect(screen.getByText('CRLF')).toBeInTheDocument()
  })

  // The footer reads like the image one: the labelled encoding on the left,
  // the bare details trailing together on the right.
  it('trails the line endings and size after the encoding', () => {
    show('first\r\nsecond\r\n')

    const meta = screen.getByText('CRLF').parentElement
    expect(meta).toHaveClass('archive-preview__meta')
    expect(meta).toContainElement(screen.getByText('15 B'))
    expect(meta).not.toContainElement(screen.getByText('Encoding: UTF-8'))
  })

  it('spells out a file that mixes them', () => {
    show('first\r\nsecond\n')

    expect(screen.getByText('Mixed CRLF + LF')).toBeInTheDocument()
  })

  it('reports line endings outside expert mode too', () => {
    show('only one line', false)

    expect(screen.getByText('No line breaks')).toBeInTheDocument()
  })
})
