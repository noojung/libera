import React, { useState, useEffect } from 'react'
import { Archive, Contrast, Info, Layers, ListTodo, Minus, Moon, Search, SlidersHorizontal, Square, Sun, X } from 'lucide-react'
import { AppMode } from '@/types'
import logoImg from '@/assets/logo.png'
import { useTranslation } from 'react-i18next'
import { applyLanguage } from '@/i18n'
import type { AppLanguage } from '@/i18n/language'
import {
  getStoredThemePreference,
  applyTheme,
  type ThemePreference
} from '@/utils/theme'
import { useExpertMode } from '@/utils/expertMode'

interface TitleBarProps {
  currentMode: AppMode
  setMode: (mode: AppMode) => void
  activeQueueCount: number
  onShowAbout: () => void
}

type DesktopPlatform = 'macos' | 'windows'

const tabs = [
  { mode: 'compress', labelKey: 'titleBar.compress', Icon: Archive },
  { mode: 'extract', labelKey: 'titleBar.extract', Icon: Layers },
  { mode: 'inspect', labelKey: 'titleBar.inspector', Icon: Search },
  { mode: 'queue', labelKey: 'titleBar.queue', Icon: ListTodo }
] satisfies { mode: AppMode; labelKey: string; Icon: typeof Archive }[]

export const TitleBar: React.FC<TitleBarProps> = ({ currentMode, setMode, activeQueueCount, onShowAbout }) => {
  const { t, i18n } = useTranslation()
  const currentLanguage: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference())
  const [isExpertMode, setExpertMode] = useExpertMode()
  const electronAPI = (window as any).electronAPI
  const platform = electronAPI?.platform as DesktopPlatform | undefined
  const isWindows = platform === 'windows'
  const platformClass = platform ? `titlebar--${platform}` : 'titlebar--browser'

  useEffect(() => {
    const handleStorage = () => {
      setThemePreference(getStoredThemePreference())
    }

    window.addEventListener?.('storage', handleStorage)

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handleMediaChange = () => {
        if (getStoredThemePreference() === 'system') {
          applyTheme('system')
        }
      }
      mediaQuery.addEventListener?.('change', handleMediaChange)
      return () => {
        mediaQuery.removeEventListener?.('change', handleMediaChange)
        window.removeEventListener?.('storage', handleStorage)
      }
    }

    return () => {
      window.removeEventListener?.('storage', handleStorage)
    }
  }, [])

  const handleCycleTheme = () => {
    const nextPreference: ThemePreference =
      themePreference === 'system'
        ? 'light'
        : themePreference === 'light'
          ? 'dark'
          : 'system'

    applyTheme(nextPreference)
    setThemePreference(nextPreference)
  }

  const handleMinimize = () => electronAPI?.minimizeWindow()
  const handleMaximize = () => electronAPI?.maximizeWindow()
  const handleClose = () => electronAPI?.closeWindow()

  return (
    <header className={`titlebar ${platformClass}`}>
      <div className="titlebar__brand">
        <img className="titlebar__logo" src={logoImg} alt="" />
        <span className="titlebar__brand-name">Libera</span>
      </div>

      <nav className="titlebar__tabs" aria-label={t('titleBar.navigation')}>
        {tabs.map(({ mode, labelKey, Icon }) => {
          const isActive = currentMode === mode

          return (
            <button
              key={mode}
              type="button"
              className={`titlebar__tab titlebar__tab--${mode}${isActive ? ' is-active' : ''}`}
              aria-label={t(labelKey)}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setMode(mode)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{t(labelKey)}</span>
              {mode === 'queue' && activeQueueCount > 0 && (
                <span className="titlebar__queue-count" aria-label={t('titleBar.activeJobs', { count: activeQueueCount })}>
                  {activeQueueCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className={`titlebar__actions${isWindows ? ' titlebar__actions--windows' : ''}`}>
        <button
          type="button"
          className={`titlebar__expert-button${isExpertMode ? ' is-active' : ''}`}
          aria-label={t('titleBar.expertModeToggle')}
          aria-pressed={isExpertMode}
          title={isExpertMode ? t('titleBar.expertModeOn') : t('titleBar.expertModeOff')}
          onClick={() => setExpertMode(!isExpertMode)}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {isExpertMode && <span className="titlebar__expert-indicator" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="titlebar__theme-button"
          aria-label={t('titleBar.themeToggle')}
          title={
            themePreference === 'system'
              ? t('titleBar.themeSystem')
              : themePreference === 'light'
                ? t('titleBar.themeLight')
                : t('titleBar.themeDark')
          }
          onClick={handleCycleTheme}
        >
          {themePreference === 'system' ? (
            <Contrast size={16} aria-hidden="true" />
          ) : themePreference === 'light' ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="titlebar__info-button"
          aria-label={t('titleBar.about')}
          title={t('titleBar.about')}
          onClick={onShowAbout}
        >
          <Info size={16} aria-hidden="true" />
        </button>
        <div className="titlebar__language" role="group" aria-label={t('language.selector')}>
          {(['en', 'ko'] as const).map(language => (
            <button
              key={language}
              type="button"
              className={`titlebar__language-button${currentLanguage === language ? ' is-active' : ''}`}
              aria-pressed={currentLanguage === language}
              title={t(language === 'ko' ? 'language.korean' : 'language.english')}
              onClick={() => applyLanguage(language)}
            >
              {language.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {isWindows && (
        <div className="titlebar__window-controls">
          <button
            type="button"
            className="titlebar__window-button"
            aria-label={t('titleBar.minimize')}
            title={t('titleBar.minimize')}
            onClick={handleMinimize}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="titlebar__window-button"
            aria-label={t('titleBar.maximize')}
            title={t('titleBar.maximize')}
            onClick={handleMaximize}
          >
            <Square size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="titlebar__window-button titlebar__window-button--close"
            aria-label={t('titleBar.close')}
            title={t('titleBar.close')}
            onClick={handleClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  )
}
