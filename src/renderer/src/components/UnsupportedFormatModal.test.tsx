import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnsupportedFormatModal } from './UnsupportedFormatModal'
import { renderWithI18n } from '@/test/render'

describe('UnsupportedFormatModal', () => {
  it('explains the refusal and focuses the way out', () => {
    renderWithI18n(<UnsupportedFormatModal onClose={vi.fn()} />)

    const dialog = screen.getByRole('alertdialog', { name: 'This archive format is not supported.' })
    expect(dialog).toHaveAccessibleDescription('Choose another archive file, or check the formats supported by Libera.')
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
  })

  it('closes on the button, the backdrop and Escape', async () => {
    const onClose = vi.fn()
    const { user, container } = renderWithI18n(<UnsupportedFormatModal onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'OK' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(container.querySelector('.unsupported-format')!)
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('leaves the dialog alone when the click lands inside it', () => {
    const onClose = vi.fn()
    renderWithI18n(<UnsupportedFormatModal onClose={onClose} />)

    fireEvent.mouseDown(screen.getByRole('alertdialog'))
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  // The formats table replaces this dialog rather than stacking on it, so
  // Escape there has to close the table alone and land back here.
  it('opens the supported formats and returns from them without closing', async () => {
    const onClose = vi.fn()
    const { user } = renderWithI18n(<UnsupportedFormatModal onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'View supported formats' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('ZIP', { selector: '.supported-formats__name' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
