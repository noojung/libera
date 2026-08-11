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
      height: '42px',
      background: '#FFFFFF',
      borderBottom: '1px solid #E2E8F0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: '16px',
      paddingRight: isElectron ? '0' : '16px',
      ...dragStyle,
      zIndex: 1000
    }}>
      {/* Left Branding */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <img
          src={logoImg}
          alt="Libera Logo"
          style={{
            width: '24px',
            height: '24px',
            objectFit: 'contain',
            borderRadius: '4px'
          }}
        />
        <span style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '-0.2px', color: '#0F172A' }}>
          Libera
        </span>
      </div>

      {/* Center Tabs */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        background: '#F1F5F9',
        padding: '3px',
        borderRadius: '8px',
        border: '1px solid #E2E8F0',
        ...noDragStyle
      }}>
        <button
          onClick={() => setMode('compress')}
          style={{
            background: currentMode === 'compress' ? '#FFFFFF' : 'transparent',
            color: currentMode === 'compress' ? '#0284C7' : '#64748B',
            border: currentMode === 'compress' ? '1px solid #CBD5E1' : '1px solid transparent',
            padding: '5px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'compress' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
            transition: 'all 0.15s ease'
          }}
        >
          <Archive size={14} />
          Compress
        </button>

        <button
          onClick={() => setMode('extract')}
          style={{
            background: currentMode === 'extract' ? '#FFFFFF' : 'transparent',
            color: currentMode === 'extract' ? '#4F46E5' : '#64748B',
            border: currentMode === 'extract' ? '1px solid #CBD5E1' : '1px solid transparent',
            padding: '5px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'extract' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
            transition: 'all 0.15s ease'
          }}
        >
          <Layers size={14} />
          Extract
        </button>

        <button
          onClick={() => setMode('inspect')}
          style={{
            background: currentMode === 'inspect' ? '#FFFFFF' : 'transparent',
            color: currentMode === 'inspect' ? '#D97706' : '#64748B',
            border: currentMode === 'inspect' ? '1px solid #CBD5E1' : '1px solid transparent',
            padding: '5px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: currentMode === 'inspect' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
            transition: 'all 0.15s ease'
          }}
        >
          <Search size={14} />
          Inspector
        </button>

        <button
          onClick={() => setMode('queue')}
          style={{
            background: currentMode === 'queue' ? '#FFFFFF' : 'transparent',
            color: currentMode === 'queue' ? '#059669' : '#64748B',
            border: currentMode === 'queue' ? '1px solid #CBD5E1' : '1px solid transparent',
            padding: '5px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            position: 'relative',
            boxShadow: currentMode === 'queue' ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
            transition: 'all 0.15s ease'
          }}
        >
          <ListTodo size={14} />
          Queue
          {activeQueueCount > 0 && (
            <span style={{
              background: '#059669',
              color: '#FFFFFF',
              borderRadius: '999px',
              width: '16px',
              height: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 800
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
              color: '#64748B',
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
              color: '#64748B',
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
              color: '#64748B',
              width: '42px',
              height: '42px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#DC2626'
              e.currentTarget.style.color = '#FFFFFF'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent'
              e.currentTarget.style.color = '#64748B'
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
