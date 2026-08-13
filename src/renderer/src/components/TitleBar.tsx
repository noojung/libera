import React from 'react'
import { Archive, Layers, ListTodo, Minus, Search, Square, X } from 'lucide-react'
import { AppMode } from '../types'
import logoImg from '../assets/logo.png'
import { useTranslation } from 'react-i18next'
import { applyLanguage } from '../i18n'
import type { AppLanguage } from '../i18n/language'

interface TitleBarProps {
  currentMode: AppMode
  setMode: (mode: AppMode) => void
  activeQueueCount: number
}

type DesktopPlatform = 'macos' | 'windows'

const tabs = [
  { mode: 'compress', labelKey: 'titleBar.compress', Icon: Archive },
  { mode: 'extract', labelKey: 'titleBar.extract', Icon: Layers },
  { mode: 'inspect', labelKey: 'titleBar.inspector', Icon: Search },
  { mode: 'queue', labelKey: 'titleBar.queue', Icon: ListTodo }
] satisfies { mode: AppMode; labelKey: string; Icon: typeof Archive }[]

export const TitleBar: React.FC<TitleBarProps> = ({ currentMode, setMode, activeQueueCount }) => {
  const { t, i18n } = useTranslation()
  const currentLanguage: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const electronAPI = (window as any).electronAPI
  const platform = electronAPI?.platform as DesktopPlatform | undefined
  const isWindows = platform === 'windows'
  const platformClass = platform ? `titlebar--${platform}` : 'titlebar--browser'

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
