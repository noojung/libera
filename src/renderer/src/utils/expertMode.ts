import { useState, useEffect, useCallback } from 'react'

export const EXPERT_MODE_STORAGE_KEY = 'libera_expert_mode'
export const EXPERT_MODE_EVENT = 'libera-expert-mode-change'

export const getStoredExpertMode = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }

  const stored = window.localStorage.getItem(EXPERT_MODE_STORAGE_KEY)
  return stored === 'true'
}

export const setStoredExpertMode = (enabled: boolean): void => {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(EXPERT_MODE_STORAGE_KEY, String(enabled))
    window.dispatchEvent(new CustomEvent(EXPERT_MODE_EVENT, { detail: { enabled } }))
  }
}

export const toggleExpertMode = (): boolean => {
  const next = !getStoredExpertMode()
  setStoredExpertMode(next)
  return next
}

export const useExpertMode = (): [boolean, (enabled: boolean) => void] => {
  const [isExpertMode, setIsExpertMode] = useState<boolean>(() => getStoredExpertMode())

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === EXPERT_MODE_STORAGE_KEY) {
        setIsExpertMode(event.newValue === 'true')
      }
    }

    const handleCustomEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ enabled: boolean }>
      if (customEvent.detail && typeof customEvent.detail.enabled === 'boolean') {
        setIsExpertMode(customEvent.detail.enabled)
      } else {
        setIsExpertMode(getStoredExpertMode())
      }
    }

    window.addEventListener?.('storage', handleStorage)
    window.addEventListener?.(EXPERT_MODE_EVENT, handleCustomEvent)

    return () => {
      window.removeEventListener?.('storage', handleStorage)
      window.removeEventListener?.(EXPERT_MODE_EVENT, handleCustomEvent)
    }
  }, [])

  const setExpertMode = useCallback((enabled: boolean) => {
    setStoredExpertMode(enabled)
    setIsExpertMode(enabled)
  }, [])

  return [isExpertMode, setExpertMode]
}
