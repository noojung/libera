import { describe, it, expect, beforeEach } from 'vitest'
import {
  THEME_STORAGE_KEY,
  getStoredThemePreference,
  getSystemTheme,
  resolveTheme,
  applyTheme,
  initTheme
} from './theme'

describe('theme utility', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('reads default stored preference as system', () => {
    expect(getStoredThemePreference()).toBe('system')
  })

  it('reads valid stored preferences', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(getStoredThemePreference()).toBe('dark')

    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(getStoredThemePreference()).toBe('light')

    localStorage.setItem(THEME_STORAGE_KEY, 'invalid')
    expect(getStoredThemePreference()).toBe('system')
  })

  it('resolves explicit preferences and system fallback', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(['light', 'dark']).toContain(getSystemTheme())
  })

  it('applies theme to documentElement and saves preference', () => {
    const resolved = applyTheme('dark')
    expect(resolved).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('initializes theme and cleans up event listener', () => {
    const { currentPreference, resolvedTheme, cleanup } = initTheme()
    expect(currentPreference).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe(resolvedTheme)
    cleanup()
  })
})
