import React, { useState, useEffect } from 'react'
import { Sliders, Archive } from 'lucide-react'
import { SelectedItem } from '../types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'

interface CompressionPanelProps {
  items: SelectedItem[]
  onStartCompress: (options: {
    format: 'zip' | 'tar' | 'gz' | 'tgz'
    level: number
    outputPath: string
    password?: string
  }) => void
}

export const CompressionPanel: React.FC<CompressionPanelProps> = ({ items, onStartCompress }) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [format, setFormat] = useState<'zip' | 'tar' | 'gz' | 'tgz'>('zip')
  const [level, setLevel] = useState<number>(6)
  const [customName] = useState<string>('archive')
  const [outputPath, setOutputPath] = useState<string>('')
  const [defaultDir, setDefaultDir] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [passwordConfirmation, setPasswordConfirmation] = useState<string>('')

  useEffect(() => {
    if ((window as any).electronAPI?.getDefaultOutputDir) {
      (window as any).electronAPI.getDefaultOutputDir().then((dir: string) => {
        if (dir) setDefaultDir(dir)
      })
    }
  }, [])

  const handleSelectSavePath = async () => {
    if ((window as any).electronAPI) {
      const defaultName = `${customName}.${format}`
      const chosenPath = await (window as any).electronAPI.selectSaveLocation(defaultName, format, {
        archiveFilter: t('dialogs.archiveFilter', { format: format.toUpperCase() }),
        allFiles: t('dialogs.allFiles')
      })
      if (chosenPath) {
        setOutputPath(chosenPath)
      }
    }
  }

  const getLevelLabel = (lvl: number) => {
    if (lvl === 0) return t('compression.levelNone', { level: lvl })
    if (lvl <= 3) return t('compression.levelFast', { level: lvl })
    if (lvl <= 6) return t('compression.levelBalanced', { level: lvl })
    return t('compression.levelMaximum', { level: lvl })
  }

  const handleCompress = () => {
    if (format === 'zip' && password !== passwordConfirmation) {
      return
    }
    const sep = defaultDir.includes('\\') ? '\\' : '/'
    const fallbackPath = defaultDir ? `${defaultDir}${sep}${customName}.${format}` : `${customName}.${format}`
    const finalOutput = outputPath || fallbackPath
    onStartCompress({
      format,
      level,
      outputPath: finalOutput,
      password: format === 'zip' ? password || undefined : undefined
    })
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  return (
    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', fontWeight: 700, color: '#362D27', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sliders size={18} color="#FF8E72" />
          {t('compression.title')}
        </h3>
        <span style={{ fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
          {t('compression.totalSize', { size: formatBytes(totalBytes, language) })}
        </span>
      </div>

      {/* Target Format Selector */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '8px', display: 'block' }}>
          {t('compression.format')}
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          {(['zip', 'tar', 'gz', 'tgz'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => setFormat(fmt)}
              style={{
                background: format === fmt ? '#FFF3E4' : '#FFFFFF',
                border: format === fmt ? '2px solid #FF8E72' : '1.5px solid #4A403A',
                color: format === fmt ? '#FF8E72' : '#362D27',
                padding: '10px',
                borderRadius: '12px',
                fontFamily: 'var(--font-cute)',
                fontSize: '16px',
                fontWeight: 700,
                cursor: 'pointer',
                textAlign: 'center',
                boxShadow: format === fmt ? '2px 2px 0px #4A403A' : 'none',
                transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
              }}
            >
              .{fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Compression Level Slider */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
          <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27' }}>
            {t('compression.level')}
          </label>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600, color: '#FF8E72' }}>
            {getLevelLabel(level)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="9"
          value={level}
          onChange={(e) => setLevel(parseInt(e.target.value))}
          style={{
            width: '100%',
            accentColor: '#FF8E72',
            cursor: 'pointer'
          }}
        />
      </div>

      {format === 'zip' && (
        <div>
          <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
            {t('compression.zipPassword')} <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: '#6E6158', fontWeight: 400 }}>{t('compression.optional')}</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <input type="password" className="input-text" placeholder={t('compression.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <input type="password" className="input-text" placeholder={t('compression.confirmPasswordPlaceholder')} value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} autoComplete="new-password" />
          </div>
          {password && password !== passwordConfirmation && (
            <p style={{ fontSize: '12px', color: '#E76F51', marginTop: '6px' }}>{t('compression.passwordMismatch')}</p>
          )}
          {password && password === passwordConfirmation && (
            <p style={{ fontSize: '12px', color: '#6E6158', marginTop: '6px' }}>{t('compression.passwordNotice')}</p>
          )}
        </div>
      )}

      {/* Save Destination */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
          {t('compression.destination')}
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input-text"
            placeholder={t('compression.destinationPlaceholder')}
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSelectSavePath} style={{ whiteSpace: 'nowrap' }}>
            {t('compression.browse')}
          </button>
        </div>
      </div>

      {/* Start Button */}
      <button
        className="btn-primary"
        onClick={handleCompress}
        disabled={items.length === 0 || (format === 'zip' && password !== passwordConfirmation)}
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '12px',
          opacity: (items.length === 0 || (format === 'zip' && password !== passwordConfirmation)) ? 0.5 : 1,
          cursor: (items.length === 0 || (format === 'zip' && password !== passwordConfirmation)) ? 'not-allowed' : 'pointer'
        }}
      >
        <Archive size={20} />
        {t('compression.start')}
      </button>
    </div>
  )
}
