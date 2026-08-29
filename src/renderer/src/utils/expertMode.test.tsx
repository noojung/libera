import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  EXPERT_MODE_STORAGE_KEY,
  getStoredExpertMode,
  setStoredExpertMode,
  toggleExpertMode,
  useExpertMode
} from './expertMode'

describe('expertMode utility', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to false when storage is empty', () => {
    expect(getStoredExpertMode()).toBe(false)
  })

  it('reads stored value correctly', () => {
    window.localStorage.setItem(EXPERT_MODE_STORAGE_KEY, 'true')
    expect(getStoredExpertMode()).toBe(true)

    window.localStorage.setItem(EXPERT_MODE_STORAGE_KEY, 'false')
    expect(getStoredExpertMode()).toBe(false)
  })

  it('sets and toggles expert mode in localStorage and triggers events', () => {
    const listener = vi.fn()
    window.addEventListener('libera-expert-mode-change', listener)
    setStoredExpertMode(true)
    expect(window.localStorage.getItem(EXPERT_MODE_STORAGE_KEY)).toBe('true')
    expect(getStoredExpertMode()).toBe(true)

    const toggled = toggleExpertMode()
    expect(toggled).toBe(false)
    expect(window.localStorage.getItem(EXPERT_MODE_STORAGE_KEY)).toBe('false')
    expect(listener).toHaveBeenCalledTimes(2)
    window.removeEventListener('libera-expert-mode-change', listener)
  })

  it('useExpertMode hook reflects state and allows toggling', () => {
    const { result } = renderHook(() => useExpertMode())
    expect(result.current[0]).toBe(false)

    act(() => {
      result.current[1](true)
    })
    expect(result.current[0]).toBe(true)
    expect(getStoredExpertMode()).toBe(true)

    act(() => {
      result.current[1](false) // setExplicit
    })
    expect(result.current[0]).toBe(false)
    expect(getStoredExpertMode()).toBe(false)
  })

  it('synchronizes every mounted hook through the custom event', () => {
    const { result } = renderHook(() => [useExpertMode(), useExpertMode()] as const)
    act(() => result.current[0][1](true))
    expect(result.current[0][0]).toBe(true)
    expect(result.current[1][0]).toBe(true)
  })
})
