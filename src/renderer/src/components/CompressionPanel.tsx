import React, { useState, useEffect } from 'react'
import { Sliders, Archive } from 'lucide-react'
import { SelectedItem } from '../types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'
import './CompressionPanel.css'

interface CompressionPanelProps {
  items: SelectedItem[]
  onStartCompress: (options: {
    format: 'zip' | 'tar' | 'gz' | 'tgz'
    level: number
    outputPath: string
    password?: string
    splitSize?: number
  }) => void
}

const MIN_SPLIT_SIZE = 1024 * 1024
const SPLIT_CHOICES = [
  { id: '100mb', bytes: 100 * 1024 * 1024, labelKey: 'compression.splitPreset100mb' },
  { id: '700mb', bytes: 700 * 1024 * 1024, labelKey: 'compression.splitPreset700mb' },
  { id: '1gb', bytes: 1024 * 1024 * 1024, labelKey: 'compression.splitPreset1gb' },
  { id: '2gb', bytes: 2 * 1024 * 1024 * 1024, labelKey: 'compression.splitPreset2gb' },
  // The largest volume a FAT32 filesystem - and zip.js - can hold.
  { id: '4gb', bytes: 0xffffffff, labelKey: 'compression.splitPreset4gb' },
  { id: 'custom', bytes: null, labelKey: 'compression.splitPresetCustom' }
] as const

type SplitPreset = (typeof SPLIT_CHOICES)[number]['id']

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
  const [splitEnabled, setSplitEnabled] = useState<boolean>(false)
  const [splitPreset, setSplitPreset] = useState<SplitPreset>('100mb')
  const [splitCustomValue, setSplitCustomValue] = useState<string>('100')
  const [splitCustomUnit, setSplitCustomUnit] = useState<'MB' | 'GB'>('MB')

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

  const splitSize = (() => {
    const preset = SPLIT_CHOICES.find((choice) => choice.id === splitPreset)
    if (preset?.bytes) return preset.bytes
    const value = Number(splitCustomValue)
    if (!Number.isFinite(value) || value <= 0) return NaN
    return Math.floor(value * (splitCustomUnit === 'GB' ? 1024 * 1024 * 1024 : 1024 * 1024))
  })()
  const splitInvalid = format === 'zip' && splitEnabled && !(splitSize >= MIN_SPLIT_SIZE)

  const handleCompress = () => {
    if (format === 'zip' && password !== passwordConfirmation) {
      return
    }
    if (splitInvalid) {
      return
    }
    const sep = defaultDir.includes('\\') ? '\\' : '/'
    const fallbackPath = defaultDir ? `${defaultDir}${sep}${customName}.${format}` : `${customName}.${format}`
    const finalOutput = outputPath || fallbackPath
    onStartCompress({
      format,
      level,
      outputPath: finalOutput,
      password: format === 'zip' ? password || undefined : undefined,
      splitSize: format === 'zip' && splitEnabled ? splitSize : undefined
    })
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  return (
    <div className="glass-panel compression-panel">
      <div className="compression-panel__header">
        <h3 className="compression-panel__title">
          <Sliders className="compression-panel__title-icon" size={18} />
          {t('compression.title')}
        </h3>
        <span className="compression-panel__summary">
          {t('compression.totalSize', { size: formatBytes(totalBytes, language) })}
        </span>
      </div>

      {/* Target Format Selector */}
      <div className="compression-panel__field">
        <label className="compression-panel__label compression-panel__label--format">
          {t('compression.format')}
        </label>
        <div className="compression-panel__format-grid">
          {(['zip', 'tar', 'gz', 'tgz'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => setFormat(fmt)}
              className={`compression-panel__format-button${format === fmt ? ' is-active' : ''}`}
            >
              .{fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Compression Level Slider */}
      <div className="compression-panel__field">
        <div className="compression-panel__level-header">
          <label className="compression-panel__label">
            {t('compression.level')}
          </label>
          <span className="compression-panel__level-value">
            {getLevelLabel(level)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="9"
          value={level}
          onChange={(e) => setLevel(parseInt(e.target.value))}
          className="compression-panel__range"
        />
      </div>

      {format === 'zip' && (
        <div className="compression-panel__field">
          <label className="compression-panel__label compression-panel__label--stacked">
            {t('compression.zipPassword')} <span className="compression-panel__optional">{t('compression.optional')}</span>
          </label>
          <div className="compression-panel__password-grid">
            <input type="password" className="input-text" placeholder={t('compression.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <input type="password" className="input-text" placeholder={t('compression.confirmPasswordPlaceholder')} value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} autoComplete="new-password" />
          </div>
          {password && password !== passwordConfirmation && (
            <p className="compression-panel__message compression-panel__message--error">{t('compression.passwordMismatch')}</p>
          )}
          {password && password === passwordConfirmation && (
            <p className="compression-panel__message">{t('compression.passwordNotice')}</p>
          )}
        </div>
      )}

      {format === 'zip' && (
        <div className="compression-panel__field">
          <label className="compression-panel__split-option">
            <input
              type="checkbox"
              className="compression-panel__checkbox"
              checked={splitEnabled}
              onChange={(e) => setSplitEnabled(e.target.checked)}
            />
            <span className="compression-panel__option-title">{t('compression.splitEnable')}</span>
          </label>

          {splitEnabled && (
            <div className="compression-panel__split-card">
              <label className="compression-panel__label">
                {t('compression.splitSize')}
              </label>
              <div className="compression-panel__split-buttons">
                {SPLIT_CHOICES.map((choice) => (
                  <button
                    key={choice.id}
                    onClick={() => setSplitPreset(choice.id)}
                    className={`compression-panel__split-button${splitPreset === choice.id ? ' is-active' : ''}`}
                  >
                    {t(choice.labelKey)}
                  </button>
                ))}
              </div>

              {splitPreset === 'custom' && (
                <div className="compression-panel__split-custom">
                  <input
                    type="number"
                    min="1"
                    className="input-text compression-panel__split-input"
                    placeholder={t('compression.splitCustomPlaceholder')}
                    value={splitCustomValue}
                    onChange={(e) => setSplitCustomValue(e.target.value)}
                  />
                  {(['MB', 'GB'] as const).map((unit) => (
                    <button
                      key={unit}
                      onClick={() => setSplitCustomUnit(unit)}
                      className={`compression-panel__split-button compression-panel__split-unit${splitCustomUnit === unit ? ' is-active' : ''}`}
                    >
                      {t(unit === 'MB' ? 'compression.splitUnitMb' : 'compression.splitUnitGb')}
                    </button>
                  ))}
                </div>
              )}

              {splitInvalid && (
                <p className="compression-panel__message compression-panel__message--error">{t('compression.splitMinimum')}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Save Destination */}
      <div className="compression-panel__field">
        <label className="compression-panel__label compression-panel__label--stacked">
          {t('compression.destination')}
        </label>
        <div className="compression-panel__destination-row">
          <input
            type="text"
            className="input-text"
            placeholder={t('compression.destinationPlaceholder')}
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          <button className="btn-secondary compression-panel__browse-button" onClick={handleSelectSavePath}>
            {t('compression.browse')}
          </button>
        </div>
      </div>

      {/* Start Button */}
      <button
        className="btn-primary compression-panel__start-button"
        onClick={handleCompress}
        disabled={items.length === 0 || (format === 'zip' && password !== passwordConfirmation) || splitInvalid}
      >
        <Archive size={20} />
        {t('compression.start')}
      </button>
    </div>
  )
}
