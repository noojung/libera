import React from 'react'
import { Archive, Layers, ListTodo, Minus, Search, Square, X } from 'lucide-react'
import { AppMode } from '../types'
import logoImg from '../assets/logo.png'

interface TitleBarProps {
  currentMode: AppMode
  setMode: (mode: AppMode) => void
  activeQueueCount: number
}

type DesktopPlatform = 'macos' | 'windows'

const tabs = [
  { mode: 'compress', label: 'Compress', Icon: Archive },
  { mode: 'extract', label: 'Extract', Icon: Layers },
  { mode: 'inspect', label: 'Inspector', Icon: Search },
  { mode: 'queue', label: 'Queue', Icon: ListTodo }
] satisfies { mode: AppMode; label: string; Icon: typeof Archive }[]

export const TitleBar: React.FC<TitleBarProps> = ({ currentMode, setMode, activeQueueCount }) => {
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

      <nav className="titlebar__tabs" aria-label="Application mode">
        {tabs.map(({ mode, label, Icon }) => {
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
              <span>{label}</span>
              {mode === 'queue' && activeQueueCount > 0 && (
                <span className="titlebar__queue-count" aria-label={`${activeQueueCount} active jobs`}>
                  {activeQueueCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {isWindows && (
        <div className="titlebar__window-controls">
          <button
            type="button"
            className="titlebar__window-button"
            aria-label="Minimize window"
            title="Minimize"
            onClick={handleMinimize}
          >
            <Minus size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="titlebar__window-button"
            aria-label="Maximize or restore window"
            title="Maximize or restore"
            onClick={handleMaximize}
          >
            <Square size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="titlebar__window-button titlebar__window-button--close"
            aria-label="Close window"
            title="Close"
            onClick={handleClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  )
}
