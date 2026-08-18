import React from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LicensesModal } from './LicensesModal'
import { renderWithI18n } from '../test/render'
import thirdPartyLicenses from '../generated/thirdPartyLicenses.json'

describe('LicensesModal', () => {
  it('lists every bundled package and shows the first one selected', () => {
    renderWithI18n(<LicensesModal onClose={vi.fn()} />)

    for (const entry of thirdPartyLicenses) {
      expect(screen.getByRole('button', { name: `${entry.name}, ${entry.version}, ${entry.license}` })).toBeInTheDocument()
    }
    expect(document.querySelector('.licenses-modal__text')?.textContent)
      .toMatch(new RegExp(`^${thirdPartyLicenses[0].text.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('surfaces the bundled 7-Zip LGPL notice, since that is the whole point of this screen', async () => {
    const { user } = renderWithI18n(<LicensesModal onClose={vi.fn()} />)

    const sevenZip = thirdPartyLicenses.find(entry => entry.name === '7-Zip')!
    await user.click(screen.getByRole('button', { name: `${sevenZip.name}, ${sevenZip.version}, ${sevenZip.license}` }))

    expect(screen.getByText(/GNU LESSER GENERAL PUBLIC LICENSE/)).toBeInTheDocument()
  })

  it('closes on the close button and on Escape', async () => {
    const onClose = vi.fn()
    const { user } = renderWithI18n(<LicensesModal onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
