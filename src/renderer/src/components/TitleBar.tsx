import React from 'react'
import { Minus, Square, X, Layers, Archive, Search, ListTodo } from 'lucide-react'
import { AppMode } from '../types'
import logoImg from '../assets/logo.png'

interface TitleBarProps {
  currentMode: AppMode
  setMode: (mode: AppMode) => void
  activeQueueCount: number
}

const dragStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export const TitleBar: React.FC<TitleBarProps> = ({ currentMode, setMode, activeQueueCount }) => {
  const isElectron = !!(window as any).electronAPI

  const handleMinimize = () => (window as any).electronAPI?.minimizeWindow()
  const handleMaximize = () => (window as any).electronAPI?.maximizeWindow()
  const handleClose = () => (window as any).electronAPI?.closeWindow()

  return (
    <div style={{
      height: '46px',
      background: '#FAF7F2',
      borderBottom: '2px solid #4A403A',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: '16px',
      paddingRight: isElectron ? '0' : '16px',
      ...dragStyle,
      zIndex: 1000
    }}>
      {/* Left Branding */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <img
          src={logoImg}
          alt="Libera Logo"
          style={{
            width: '28px',
            height: '28px',
            objectFit: 'contain',
            borderRadius: '50%',
            background: '#FFFFFF',
            padding: '2px',
            border: '1.5px solid #4A403A'
          }}
        />
        <span style={{
          fontFamily: 'var(--font-cute)',
          fontWeight: 700,
          fontSize: '20px',
          letterSpacing: '0.5px',
          color: '#362D27'
        }}>
          Libera
        </span>
      </div>

      {/* Center Tabs */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: '#FFF3E4',
        padding: '3px 4px',
        borderRadius: '14px',
        border: '2px solid #4A403A',
        gap: '4px',
        ...noDragStyle
      }}>
        <button
          onClick={() => setMode('compress')}
          style={{
            background: currentMode === 'compress' ? '#FF8E72' : 'transparent',
            color: currentMode === 'compress' ? '#FFFFFF' : '#6E6158',
            border: currentMode === 'compress' ? '1.5px solid #4A403A' : '1.5px solid transparent',
            padding: '4px 14px',
            borderRadius: '10px',
            fontSize: '14px',
            fontFamily: 'var(--font-cute)',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'compress' ? '1.5px 1.5px 0px #4A403A' : 'none',
            transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}
        >
          <Archive size={14} />
          Compress
        </button>

        <button
          onClick={() => setMode('extract')}
          style={{
            background: currentMode === 'extract' ? '#5A9EED' : 'transparent',
            color: currentMode === 'extract' ? '#FFFFFF' : '#6E6158',
            border: currentMode === 'extract' ? '1.5px solid #4A403A' : '1.5px solid transparent',
            padding: '4px 14px',
            borderRadius: '10px',
            fontSize: '14px',
            fontFamily: 'var(--font-cute)',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'extract' ? '1.5px 1.5px 0px #4A403A' : 'none',
            transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}
        >
          <Layers size={14} />
          Extract
        </button>

        <button
          onClick={() => setMode('inspect')}
          style={{
            background: currentMode === 'inspect' ? '#F4A261' : 'transparent',
            color: currentMode === 'inspect' ? '#FFFFFF' : '#6E6158',
            border: currentMode === 'inspect' ? '1.5px solid #4A403A' : '1.5px solid transparent',
            padding: '4px 14px',
            borderRadius: '10px',
            fontSize: '14px',
            fontFamily: 'var(--font-cute)',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'inspect' ? '1.5px 1.5px 0px #4A403A' : 'none',
            transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}
        >
          <Search size={14} />
          Inspector
        </button>

        <button
          onClick={() => setMode('queue')}
          style={{
            background: currentMode === 'queue' ? '#6BBE66' : 'transparent',
            color: currentMode === 'queue' ? '#FFFFFF' : '#6E6158',
            border: currentMode === 'queue' ? '1.5px solid #4A403A' : '1.5px solid transparent',
            padding: '4px 14px',
            borderRadius: '10px',
            fontSize: '14px',
            fontFamily: 'var(--font-cute)',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            position: 'relative',
            boxShadow: currentMode === 'queue' ? '1.5px 1.5px 0px #4A403A' : 'none',
            transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }}
        >
          <ListTodo size={14} />
          Queue
          {activeQueueCount > 0 && (
            <span style={{
              background: '#E76F51',
              color: '#FFFFFF',
              borderRadius: '999px',
              width: '18px',
              height: '18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontFamily: 'var(--font-cute)',
              fontWeight: 800,
              border: '1px solid #4A403A'
            }}>
              {activeQueueCount}
            </span>
          )}
        </button>
      </div>

      {/* Right Window Controls */}
      {isElectron && (
        <div style={{ display: 'flex', alignItems: 'center', ...noDragStyle }}>
          <button
            onClick={handleMinimize}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#6E6158',
              width: '42px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer'
            }}
          >
            <Minus size={14} />
          </button>
          <button
            onClick={handleMaximize}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#6E6158',
              width: '42px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer'
            }}
          >
            <Square size={12} />
          </button>
          <button
            onClick={handleClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#6E6158',
              width: '42px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#E76F51'
              e.currentTarget.style.color = '#FFFFFF'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
              e.currentTarget.style.color = '#6E6158'
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
