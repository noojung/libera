import React, { useState } from 'react'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithI18n } from '@/test/render'
import { Select, type SelectOption } from './Select'

type Flavor = 'apple' | 'banana' | 'cherry'

const options: readonly SelectOption<Flavor>[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana', disabled: true },
  { value: 'cherry', label: 'Cherry' }
]

function Harness({ disabled = false, onChange = vi.fn() }: { disabled?: boolean; onChange?: (value: Flavor) => void }) {
  const [value, setValue] = useState<Flavor>('apple')
  return (
    <div>
      <label htmlFor="flavor">Flavor</label>
      <Select
        id="flavor"
        ariaLabel="Flavor"
        value={value}
        options={options}
        disabled={disabled}
        onChange={(nextValue) => {
          setValue(nextValue)
          onChange(nextValue)
        }}
      />
      <button type="button">Outside</button>
    </div>
  )
}

describe('Select', () => {
  it('opens a portaled listbox and selects an option with the pointer', async () => {
    const onChange = vi.fn()
    const { user } = renderWithI18n(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Flavor' })

    expect(trigger).toHaveTextContent('Apple')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: 'Flavor' }).parentElement).toBe(document.body)
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-disabled', 'true')

    await user.click(screen.getByRole('option', { name: 'Cherry' }))
    expect(onChange).toHaveBeenCalledWith('cherry')
    expect(trigger).toHaveTextContent('Cherry')
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('navigates with the keyboard and skips disabled options', async () => {
    const onChange = vi.fn()
    const { user } = renderWithI18n(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Flavor' })

    trigger.focus()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('cherry')
    expect(trigger).toHaveTextContent('Cherry')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports Home, End and typeahead without committing until Enter', async () => {
    const onChange = vi.fn()
    const { user } = renderWithI18n(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Flavor' })

    trigger.focus()
    await user.keyboard('c')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(onChange).not.toHaveBeenCalled()
    await user.keyboard('{Home}{End}{Enter}')

    expect(onChange).toHaveBeenCalledWith('cherry')
  })

  it('closes on Escape and outside interaction without changing the value', async () => {
    const onChange = vi.fn()
    const { user } = renderWithI18n(<Harness onChange={onChange} />)
    const trigger = screen.getByRole('combobox', { name: 'Flavor' })

    await user.click(trigger)
    await user.keyboard('{ArrowDown}{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps Escape from closing a parent surface', async () => {
    const onParentKeyDown = vi.fn()
    const { user } = renderWithI18n(
      <div onKeyDown={onParentKeyDown}>
        <Harness />
      </div>
    )

    await user.click(screen.getByRole('combobox', { name: 'Flavor' }))
    await user.keyboard('{Escape}')

    expect(onParentKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('does not open while disabled', async () => {
    const { user } = renderWithI18n(<Harness disabled />)
    const trigger = screen.getByRole('combobox', { name: 'Flavor' })

    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
