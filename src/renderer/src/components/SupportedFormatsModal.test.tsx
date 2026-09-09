import React from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SupportedFormatsModal } from './SupportedFormatsModal'
import { renderWithI18n } from '@/test/render'
import { SUPPORTED_ARCHIVE_EXTENSIONS, SUPPORTED_FORMATS } from '@/utils/archivePaths'

/**
 * The row for one format, matched on its name cell exactly. A prefix would not
 * do: TAR, TAR.GZ, TAR.XZ and TAR.BZ2 all begin the same way.
 */
const rowFor = (name: string): HTMLElement => {
  const cell = screen.getAllByText(name, { selector: '.supported-formats__name' })
    .find(node => node.textContent === name)
  if (!cell) throw new Error(`no row for ${name}`)
  return cell.closest('tr')!
}

describe('the supported formats table', () => {
  it('lists every format the app reads', () => {
    renderWithI18n(<SupportedFormatsModal onClose={vi.fn()} />)
    // One header row plus one per format.
    expect(screen.getAllByRole('row')).toHaveLength(SUPPORTED_FORMATS.length + 1)
    for (const format of SUPPORTED_FORMATS) {
      expect(screen.getByText(format.name)).toBeInTheDocument()
    }
  })

  // The whole reason for a table rather than a list: four of these are read
  // only, and a flat list would send someone looking for TAR.XZ in the
  // compression menu.
  it('separates what can be written from what can only be opened', () => {
    renderWithI18n(<SupportedFormatsModal onClose={vi.fn()} />)

    // Compress, extract, read, password, split - in that order.
    const zip = within(rowFor('ZIP')).getAllByRole('img')
    expect(zip.map(mark => mark.getAttribute('aria-label')))
      .toEqual(['Yes', 'Yes', 'Yes', 'Yes', 'Yes'])

    const tarXz = within(rowFor('TAR.XZ')).getAllByRole('img')
    expect(tarXz.map(mark => mark.getAttribute('aria-label')))
      .toEqual(['No', 'Yes', 'Yes', 'No', 'No'])

    // TAR writes but has no password or split of its own.
    const tar = within(rowFor('TAR')).getAllByRole('img')
    expect(tar.map(mark => mark.getAttribute('aria-label')))
      .toEqual(['Yes', 'Yes', 'Yes', 'No', 'No'])
  })

  it('shows the suffixes each format is recognised by', () => {
    renderWithI18n(<SupportedFormatsModal onClose={vi.fn()} />)
    expect(within(rowFor('TAR.BZ2')).getByText('.tar.bz2 · .tbz2 · .tbz')).toBeInTheDocument()
  })

  it('closes on the button, the backdrop and Escape', () => {
    const onClose = vi.fn()
    const { container } = renderWithI18n(<SupportedFormatsModal onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(container.querySelector('.supported-formats')!)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('leaves the dialog alone when the click lands inside it', () => {
    const onClose = vi.fn()
    const { container } = renderWithI18n(<SupportedFormatsModal onClose={onClose} />)

    fireEvent.mouseDown(container.querySelector('.supported-formats__dialog')!)
    expect(onClose).not.toHaveBeenCalled()
  })
})

// The table is a third copy of what the README and the site also say, so it is
// built from the constants rather than typed out. This is what catches a
// format added to one and forgotten in the other.
describe('the table against the extensions the app accepts', () => {
  it('covers every supported extension exactly once', () => {
    const listed = SUPPORTED_FORMATS.flatMap(format => format.extensions)
    expect([...listed].sort()).toEqual([...SUPPORTED_ARCHIVE_EXTENSIONS].sort())
  })

  it('marks a format as writable only when it can be written', () => {
    const writable = SUPPORTED_FORMATS.filter(format => format.compress).map(format => format.name)
    expect(writable).toEqual(['ZIP', '7Z', 'TAR', 'TAR.GZ', 'GZ'])
  })

  it('says every listed format can be extracted and read', () => {
    expect(SUPPORTED_FORMATS.every(format => format.extract && format.read)).toBe(true)
  })

  it('offers a password and split sets only where the container defines them', () => {
    const named = (key: 'password' | 'split') =>
      SUPPORTED_FORMATS.filter(format => format[key]).map(format => format.name)
    expect(named('password')).toEqual(['ZIP', '7Z'])
    expect(named('split')).toEqual(['ZIP', '7Z'])
  })
})
