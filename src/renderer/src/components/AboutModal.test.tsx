import React from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AboutModal } from './AboutModal'
import { renderWithI18n } from '@/test/render'
import { installElectronApi } from '@/test/electronApi'
import appInfo from '@/generated/appInfo.json'

describe('AboutModal', () => {
  it('shows the app name, version and copyright', () => {
    installElectronApi()
    renderWithI18n(<AboutModal onClose={vi.fn()} onShowLicenses={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Libera' })).toBeInTheDocument()
    expect(screen.getByText(`Version ${appInfo.version}`)).toBeInTheDocument()
    expect(screen.getByText(`© ${appInfo.copyrightYear} ${appInfo.copyrightHolder}`)).toBeInTheDocument()
  })

  it('opens the homepage and the repository in the browser', async () => {
    const api = installElectronApi()
    const { user } = renderWithI18n(<AboutModal onClose={vi.fn()} onShowLicenses={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Website/ }))
    expect(api.openExternalLink).toHaveBeenCalledWith(appInfo.homepage)

    await user.click(screen.getByRole('button', { name: /View source/ }))
    expect(api.openExternalLink).toHaveBeenCalledWith(appInfo.repositoryUrl)
  })

  it('leads to the licenses list rather than showing it here', async () => {
    installElectronApi()
    const onShowLicenses = vi.fn()
    const { user } = renderWithI18n(<AboutModal onClose={vi.fn()} onShowLicenses={onShowLicenses} />)

    // The licence text itself belongs one level down; this screen only points at it.
    expect(screen.queryByText(/GNU LESSER GENERAL PUBLIC LICENSE/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Open source licenses/ }))
    expect(onShowLicenses).toHaveBeenCalledOnce()
  })

  it('closes on the close button and on Escape', async () => {
    installElectronApi()
    const onClose = vi.fn()
    const { user } = renderWithI18n(<AboutModal onClose={onClose} onShowLicenses={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
