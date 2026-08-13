import React from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'
import { renderWithI18n } from '../test/render'
import { installElectronApi } from '../test/electronApi'
import { applyLanguage } from '../i18n'

vi.mock('../i18n', () => ({ applyLanguage: vi.fn() }))

describe('TitleBar', () => {
  it('switches tabs, displays active jobs, and keeps English first', async () => {
    installElectronApi()
    const setMode = vi.fn()
    const { user } = renderWithI18n(<TitleBar currentMode="compress" setMode={setMode} activeQueueCount={2} />)

    expect(screen.getByRole('button', { name: 'Compress' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByLabelText('2 active jobs')).toHaveTextContent('2')
    const languageButtons = screen.getAllByRole('button').filter(button => ['EN', 'KO'].includes(button.textContent || ''))
    expect(languageButtons.map(button => button.textContent)).toEqual(['EN', 'KO'])

    await user.click(screen.getByRole('button', { name: 'Extract' }))
    await user.click(screen.getByTitle('Korean'))

    expect(setMode).toHaveBeenCalledWith('extract')
    expect(applyLanguage).toHaveBeenCalledWith('ko')
  })

  it('calls Windows window controls and hides them on macOS', async () => {
    const api = installElectronApi()
    const { user, rerender } = renderWithI18n(<TitleBar currentMode="compress" setMode={vi.fn()} activeQueueCount={0} />)

    await user.click(screen.getByRole('button', { name: 'Minimize window' }))
    await user.click(screen.getByRole('button', { name: 'Maximize or restore window' }))
    await user.click(screen.getByRole('button', { name: 'Close window' }))
    expect(api.minimizeWindow).toHaveBeenCalledOnce()
    expect(api.maximizeWindow).toHaveBeenCalledOnce()
    expect(api.closeWindow).toHaveBeenCalledOnce()

    ;(api as any).platform = 'macos'
    rerender(<TitleBar currentMode="compress" setMode={vi.fn()} activeQueueCount={0} />)
    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument()
  })
})
