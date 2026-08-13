import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PasswordPromptModal } from './PasswordPromptModal'
import { renderWithI18n } from '../test/render'

describe('PasswordPromptModal', () => {
  it('requires a password and submits the entered value', async () => {
    const onConfirm = vi.fn()
    const { user } = renderWithI18n(
      <PasswordPromptModal archiveName="secret.zip" onConfirm={onConfirm} onCancel={vi.fn()} />
    )
    const submit = screen.getByRole('button', { name: 'Extract' })
    expect(submit).toBeDisabled()

    await user.type(screen.getByPlaceholderText('Enter password'), 'correct horse')
    await user.click(submit)
    expect(onConfirm).toHaveBeenCalledWith('correct horse')
  })

  it('shows retry feedback, cancels from controls, and resets on archive change', async () => {
    const onCancel = vi.fn()
    const { user, rerender, container } = renderWithI18n(
      <PasswordPromptModal archiveName="one.zip" hasIncorrectPassword onConfirm={vi.fn()} onCancel={onCancel} />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('incorrect')
    const input = screen.getByPlaceholderText('Enter password')
    await user.type(input, 'old')

    rerender(<PasswordPromptModal archiveName="two.zip" onConfirm={vi.fn()} onCancel={onCancel} />)
    expect(input).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.mouseDown(container.firstElementChild!)
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
