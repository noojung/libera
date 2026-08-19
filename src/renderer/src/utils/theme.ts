export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'libera_theme'

export const getStoredThemePreference = (): ThemePreference => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'system'
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored
  }

  return 'system'
}

export const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light'
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const resolveTheme = (preference: ThemePreference): ResolvedTheme => {
  if (preference === 'system') {
    return getSystemTheme()
  }

  return preference
}

export const applyTheme = (preference: ThemePreference): ResolvedTheme => {
  const resolved = resolveTheme(preference)

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  }

  return resolved
}

export const initTheme = (): {
  currentPreference: ThemePreference
  resolvedTheme: ResolvedTheme
  cleanup: () => void
} => {
  const currentPreference = getStoredThemePreference()
  const resolvedTheme = applyTheme(currentPreference)

  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { currentPreference, resolvedTheme, cleanup: () => {} }
  }

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleChange = () => {
    const preference = getStoredThemePreference()
    if (preference === 'system') {
      applyTheme('system')
    }
  }

  mediaQuery.addEventListener?.('change', handleChange)

  return {
    currentPreference,
    resolvedTheme,
    cleanup: () => {
      mediaQuery.removeEventListener?.('change', handleChange)
    }
  }
}
