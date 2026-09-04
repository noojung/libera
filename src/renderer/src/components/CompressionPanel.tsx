import React, { useState, useEffect } from 'react'
import { Sliders, Archive, Package, Lock, Files } from 'lucide-react'
import { SelectedItem } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/i18n/format'
import {
  COMPRESSION_FORMATS,
  archiveExtension,
  formatLabel,
  saveDialogExtension,
  compressionLevels,
  supportsHeaderEncryption,
  supportsLevel,
  supportsPassword,
  supportsSplit,
  withArchiveExtension,
  type ArchiveFormat
} from '@/utils/archivePaths'
import type { AppLanguage } from '@/i18n/language'
import { useExpertMode } from '@/utils/expertMode'
import { Select } from './Select'
import type {
  SevenZipMethod,
  SevenZipMethodOverride,
  ZipMethod,
  ZipMethodOverride
} from '@services/compressor'
import { ZipMethodOverridesModal } from './ZipMethodOverridesModal'
import { SevenZipMethodOverridesModal } from './SevenZipMethodOverridesModal'
import './CompressionPanel.css'

export type ZipEncryptionMethod = 'zip20' | 'aes256' | 'aes128'
export type DeflateStrategy = 'default' | 'filtered' | 'huffman_only' | 'rle' | 'fixed'
export type MatchFinderWordSize = 32 | 64 | 128 | 273

export interface StartCompressOptions {
  format: ArchiveFormat
  level: number
  outputPath: string
  password?: string
  encryptFileNames?: boolean
  splitSize?: number
  encryptionMethod?: ZipEncryptionMethod
  zipMethod?: ZipMethod
  zipMethodOverrides?: ZipMethodOverride[]
  sevenZipMethod?: SevenZipMethod
  sevenZipMethodOverrides?: SevenZipMethodOverride[]
  dictionarySize?: number
  matchFinderWordSize?: MatchFinderWordSize
  searchCycles?: number
  solidArchive?: boolean
  deflateStrategy?: DeflateStrategy
  memLevel?: number
}

interface CompressionPanelProps {
  items: SelectedItem[]
  onStartCompress: (options: StartCompressOptions) => void
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

const DEFAULT_LEVELS: Record<ArchiveFormat, number> = {
  zip: 6,
  tar: 0,
  gz: 6,
  tgz: 6,
  '7z': 5
}

const DEFAULT_DICTIONARY_SIZE = 16 * 1024 * 1024
const DEFAULT_MATCH_FINDER_WORD_SIZE: MatchFinderWordSize = 32
const DEFAULT_SEARCH_CYCLES = 32
const DEFAULT_MEM_LEVEL = 8

const DICTIONARY_SIZES = [
  { label: '64 KB', value: 64 * 1024 },
  { label: '1 MB', value: 1024 * 1024 },
  { label: '2 MB', value: 2 * 1024 * 1024 },
  { label: '4 MB', value: 4 * 1024 * 1024 },
  { label: '8 MB', value: 8 * 1024 * 1024 },
  { label: '16 MB', value: 16 * 1024 * 1024 },
  { label: '32 MB', value: 32 * 1024 * 1024 },
  { label: '64 MB', value: 64 * 1024 * 1024 },
  { label: '128 MB', value: 128 * 1024 * 1024 }
]

/** Wraps expert-only controls in the dashed frame, or renders them bare. */
const ExpertFrame: React.FC<{
  enabled: boolean
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}> = ({ enabled, title, icon, children }) => {
  if (!enabled) return <>{children}</>
  return (
    <div className="expert-card expert-card--inline">
      <div className="expert-card__header">
        <div className="expert-card__title">
          {icon}
          {title}
        </div>
      </div>
      {children}
    </div>
  )
}

export const CompressionPanel: React.FC<CompressionPanelProps> = ({ items, onStartCompress }) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [isExpertMode] = useExpertMode()

  const [format, setFormat] = useState<ArchiveFormat>('zip')
  const [level, setLevel] = useState<number>(DEFAULT_LEVELS.zip)
  const [customName] = useState<string>('archive')
  const [outputPath, setOutputPath] = useState<string>('')
  const [defaultDir, setDefaultDir] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [passwordConfirmation, setPasswordConfirmation] = useState<string>('')
  const [encryptFileNames, setEncryptFileNames] = useState<boolean>(false)
  const [splitEnabled, setSplitEnabled] = useState<boolean>(false)
  const [splitPreset, setSplitPreset] = useState<SplitPreset>('100mb')
  const [splitCustomValue, setSplitCustomValue] = useState<string>('100')
  const [splitCustomUnit, setSplitCustomUnit] = useState<'B' | 'KB' | 'MB' | 'GB'>('MB')

  // Expert options state
  const [zipEncryptionMethod, setZipEncryptionMethod] = useState<ZipEncryptionMethod>('zip20')
  const [zipMethod, setZipMethod] = useState<ZipMethod>('deflate')
  const [zipPerFileEnabled, setZipPerFileEnabled] = useState(false)
  const [zipMethodOverrides, setZipMethodOverrides] = useState<ZipMethodOverride[]>([])
  const [showZipMethodOverrides, setShowZipMethodOverrides] = useState(false)
  const [sevenZipMethod, setSevenZipMethod] = useState<SevenZipMethod>('lzma2')
  const [sevenZipPerFileEnabled, setSevenZipPerFileEnabled] = useState(false)
  const [sevenZipMethodOverrides, setSevenZipMethodOverrides] = useState<SevenZipMethodOverride[]>([])
  const [showSevenZipMethodOverrides, setShowSevenZipMethodOverrides] = useState(false)
  const [dictionarySize, setDictionarySize] = useState<number>(DEFAULT_DICTIONARY_SIZE)
  const [matchFinderWordSize, setMatchFinderWordSize] = useState<MatchFinderWordSize>(DEFAULT_MATCH_FINDER_WORD_SIZE)
  const [searchCycles, setSearchCycles] = useState<number>(DEFAULT_SEARCH_CYCLES)
  const [solidBlock, setSolidBlock] = useState<boolean>(false)
  const [deflateStrategy, setDeflateStrategy] = useState<DeflateStrategy>('default')
  const [memLevel, setMemLevel] = useState<number>(DEFAULT_MEM_LEVEL)

  useEffect(() => {
    if ((window as any).electronAPI?.getDefaultOutputDir) {
      (window as any).electronAPI.getDefaultOutputDir().then((dir: string) => {
        if (dir) setDefaultDir(dir)
      })
    }
  }, [])

  useEffect(() => {
    const isWindows = (window as any).electronAPI?.platform === 'windows'
    const normalize = (value: string) => {
      const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
      return isWindows ? normalized.toLowerCase() : normalized
    }
    const belongsToInput = (sourcePath: string) => {
      const rulePath = normalize(sourcePath)
      return items.some(item => {
        const itemPath = normalize(item.path)
        return rulePath === itemPath || (item.isDirectory && rulePath.startsWith(`${itemPath}/`))
      })
    }
    // The input list is owned by App, so pruning is the synchronization these
    // controls must perform when that external selection changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setZipMethodOverrides(current => current.filter(rule => belongsToInput(rule.sourcePath)))
    setSevenZipMethodOverrides(current => current.filter(rule => belongsToInput(rule.sourcePath)))
  }, [items])

  const handleSelectSavePath = async () => {
    if ((window as any).electronAPI) {
      const defaultName = `${customName}${archiveExtension(format)}`
      const chosenPath = await (window as any).electronAPI.selectSaveLocation(defaultName, saveDialogExtension(format), {
        archiveFilter: t('dialogs.archiveFilter', { format: formatLabel(format) }),
        allFiles: t('dialogs.allFiles')
      })
      if (chosenPath) {
        // The dialog can hand back an alias extension, or none at all.
        setOutputPath(withArchiveExtension(chosenPath, format))
      }
    }
  }

  const handleFormatChange = (nextFormat: ArchiveFormat) => {
    if (nextFormat === format) return

    setFormat(nextFormat)
    setLevel(DEFAULT_LEVELS[nextFormat])
    setOutputPath('')
    setPassword('')
    setPasswordConfirmation('')
    setEncryptFileNames(false)
    setSplitEnabled(false)
    setSplitPreset('100mb')
    setSplitCustomValue('100')
    setSplitCustomUnit('MB')
    setZipEncryptionMethod('zip20')
    setZipMethod('deflate')
    setZipPerFileEnabled(false)
    setZipMethodOverrides([])
    setShowZipMethodOverrides(false)
    setSevenZipMethod('lzma2')
    setSevenZipPerFileEnabled(false)
    setSevenZipMethodOverrides([])
    setShowSevenZipMethodOverrides(false)
    setDictionarySize(DEFAULT_DICTIONARY_SIZE)
    setMatchFinderWordSize(DEFAULT_MATCH_FINDER_WORD_SIZE)
    setSearchCycles(DEFAULT_SEARCH_CYCLES)
    setSolidBlock(false)
    setDeflateStrategy('default')
    setMemLevel(DEFAULT_MEM_LEVEL)
  }

  const getLevelLabel = (lvl: number) => {
    const names: Record<number, string> = format === '7z'
      ? { 0: 'levelStore', 1: 'levelFastest', 3: 'levelFast', 5: 'levelNormal', 7: 'levelMaximum', 9: 'levelUltra' }
      : { 0: 'levelStore', 1: 'levelFastest', 6: 'levelNormal', 9: 'levelMaximum' }
    return t(`compression.${names[lvl] ?? 'levelPlain'}`, { level: lvl })
  }

  const zipPerFileActive = isExpertMode && zipPerFileEnabled
  const sevenZipPerFileActive = isExpertMode && sevenZipPerFileEnabled
  const perFileCompressionActive = format === 'zip'
    ? zipPerFileActive
    : format === '7z' && sevenZipPerFileActive
  const storeSelected = isExpertMode && !perFileCompressionActive && (
    (format === 'zip' && zipMethod === 'store') ||
    (format === '7z' && sevenZipMethod === 'copy')
  )
  const compressedMethodSelected = isExpertMode && !perFileCompressionActive && (
    (format === 'zip' && zipMethod !== 'store') ||
    (format === '7z' && sevenZipMethod === 'lzma2')
  )
  const effectiveLevel = storeSelected ? 0 : compressedMethodSelected && level === 0 ? 1 : level
  const deflateTuned = (format === 'zip' && !zipPerFileActive && zipMethod === 'deflate') ||
    format === 'tgz' || format === 'gz'
  const sevenZipGlobalTuning = format === '7z' && !sevenZipPerFileActive && sevenZipMethod === 'lzma2'

  const splitSize = (() => {
    const preset = SPLIT_CHOICES.find((choice) => choice.id === splitPreset)
    if (preset?.bytes) return preset.bytes
    const value = Number(splitCustomValue)
    if (!Number.isFinite(value) || value <= 0) return NaN
    const multiplier = splitCustomUnit === 'GB'
      ? 1024 * 1024 * 1024
      : splitCustomUnit === 'MB'
        ? 1024 * 1024
        : splitCustomUnit === 'KB'
          ? 1024
          : 1
    return Math.floor(value * multiplier)
  })()
  const splitInvalid = supportsSplit(format) && splitEnabled && !(splitSize >= MIN_SPLIT_SIZE)

  const handleCompress = () => {
    if (supportsPassword(format) && password !== passwordConfirmation) {
      return
    }
    if (splitInvalid) {
      return
    }
    const sep = defaultDir.includes('\\') ? '\\' : '/'
    const defaultName = `${customName}${archiveExtension(format)}`
    const fallbackPath = defaultDir ? `${defaultDir}${sep}${defaultName}` : defaultName
    const finalOutput = outputPath || fallbackPath

    onStartCompress({
      format,
      level: effectiveLevel,
      outputPath: finalOutput,
      password: supportsPassword(format) ? password || undefined : undefined,
      encryptFileNames: isExpertMode && supportsHeaderEncryption(format) && password ? encryptFileNames : undefined,
      splitSize: supportsSplit(format) && splitEnabled ? splitSize : undefined,
      ...(isExpertMode
        ? {
            encryptionMethod: format === 'zip' ? zipEncryptionMethod : undefined,
            zipMethod: format === 'zip' && !zipPerFileActive ? zipMethod : undefined,
            zipMethodOverrides: format === 'zip' && zipPerFileActive && zipMethodOverrides.length > 0
              ? zipMethodOverrides
              : undefined,
            sevenZipMethod: format === '7z' && !sevenZipPerFileActive ? sevenZipMethod : undefined,
            sevenZipMethodOverrides: format === '7z' && sevenZipPerFileActive && sevenZipMethodOverrides.length > 0
              ? sevenZipMethodOverrides
              : undefined,
            dictionarySize: sevenZipGlobalTuning ? dictionarySize : undefined,
            matchFinderWordSize: sevenZipGlobalTuning ? matchFinderWordSize : undefined,
            searchCycles: sevenZipGlobalTuning ? searchCycles : undefined,
            solidArchive: format === '7z' && (sevenZipPerFileActive || sevenZipMethod === 'lzma2')
              ? solidBlock
              : undefined,
            deflateStrategy: deflateTuned ? deflateStrategy : undefined,
            memLevel: deflateTuned ? memLevel : undefined
          }
        : {})
    })
  }

  const levels = compressionLevels(format)
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
          {COMPRESSION_FORMATS.map((fmt) => (
            <button
              key={fmt}
              onClick={() => handleFormatChange(fmt)}
              className={`compression-panel__format-button${format === fmt ? ' is-active' : ''}`}
            >
              .{formatLabel(fmt)}
            </button>
          ))}
        </div>
      </div>

      {/* Compression Level Slider */}
      {supportsLevel(format) && !perFileCompressionActive && (
        <div className="compression-panel__field">
          <div className="compression-panel__level-header">
            <label className="compression-panel__label">
              {t('compression.level')}
            </label>
            <span className="compression-panel__level-value">
              {getLevelLabel(effectiveLevel)}
            </span>
          </div>
          <input
            type="range"
            min="0"
            max={levels.length - 1}
            value={Math.max(0, levels.indexOf(effectiveLevel))}
            onChange={(e) => setLevel(levels[parseInt(e.target.value)])}
            className="compression-panel__range"
            disabled={storeSelected}
          />
        </div>
      )}

      {/* Expert Mode Compression Configuration Card */}
      {isExpertMode && format !== 'tar' && (
        <div className="expert-card">
          <div className="expert-card__header">
            <div className="expert-card__title">
              <Package size={16} />
              {t('compression.expertTitle')}
            </div>
          </div>

          {format === 'zip' && (
            <>
              <div
                className={`compression-panel__zip-overrides${
                  zipPerFileActive ? ' is-active' : ' compression-panel__zip-overrides--with-settings'
                }${items.length === 0 ? ' is-disabled' : ''}`}
              >
                <button
                  type="button"
                  className="compression-panel__zip-overrides-open"
                  aria-label={t('compression.zipOverridesButton')}
                  onClick={() => setShowZipMethodOverrides(true)}
                  disabled={!zipPerFileEnabled || items.length === 0}
                >
                  <span className="compression-panel__zip-overrides-copy">
                    <Files size={16} />
                    <span>
                      <span className="compression-panel__zip-overrides-title">{t('compression.zipOverridesButton')}</span>
                      <span className="compression-panel__zip-overrides-hint">{t('compression.zipOverridesButtonHint')}</span>
                    </span>
                  </span>
                  {zipMethodOverrides.length > 0 && (
                    <span className="compression-panel__zip-overrides-badge">
                      {t('compression.zipOverridesCount', { count: zipMethodOverrides.length })}
                    </span>
                  )}
                </button>
                <label className={`compression-panel__mode-toggle${items.length === 0 ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('compression.zipOverridesEnable')}
                    checked={zipPerFileEnabled}
                    disabled={items.length === 0}
                    onChange={(event) => {
                      setZipPerFileEnabled(event.target.checked)
                      if (!event.target.checked) setShowZipMethodOverrides(false)
                    }}
                  />
                  <span className="compression-panel__mode-toggle-track" aria-hidden="true">
                    <span className="compression-panel__mode-toggle-thumb" />
                  </span>
                </label>
              </div>

              {!zipPerFileActive && (
                <div className="compression-panel__expert-row">
                  <label className="compression-panel__expert-label" htmlFor="compression-zip-method">
                    {t('compression.zipMethod')}
                  </label>
                  <Select<ZipMethod>
                    id="compression-zip-method"
                    ariaLabel={t('compression.zipMethod')}
                    value={zipMethod}
                    onChange={setZipMethod}
                    options={[
                      { value: 'deflate', label: t('compression.methodDeflate') },
                      { value: 'store', label: t('compression.methodStore') },
                      { value: 'lzma', label: t('compression.methodZipLzma') },
                      { value: 'zstd', label: t('compression.methodZipZstd') }
                    ]}
                  />
                </div>
              )}
            </>
          )}

          {/* 7Z Codec & Dictionary Tuning */}
          {format === '7z' && (
            <>
              <div
                className={`compression-panel__zip-overrides compression-panel__zip-overrides--with-settings${
                  sevenZipPerFileActive ? ' is-active' : ''
                }${items.length === 0 ? ' is-disabled' : ''}`}
              >
                <button
                  type="button"
                  className="compression-panel__zip-overrides-open"
                  aria-label={t('compression.sevenZipOverridesButton')}
                  onClick={() => setShowSevenZipMethodOverrides(true)}
                  disabled={!sevenZipPerFileEnabled || items.length === 0}
                >
                  <span className="compression-panel__zip-overrides-copy">
                    <Files size={16} />
                    <span>
                      <span className="compression-panel__zip-overrides-title">{t('compression.sevenZipOverridesButton')}</span>
                      <span className="compression-panel__zip-overrides-hint">{t('compression.sevenZipOverridesButtonHint')}</span>
                    </span>
                  </span>
                  {sevenZipMethodOverrides.length > 0 && (
                    <span className="compression-panel__zip-overrides-badge">
                      {t('compression.zipOverridesCount', { count: sevenZipMethodOverrides.length })}
                    </span>
                  )}
                </button>
                <label className={`compression-panel__mode-toggle${items.length === 0 ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={t('compression.zipOverridesEnable')}
                    checked={sevenZipPerFileEnabled}
                    disabled={items.length === 0}
                    onChange={(event) => {
                      setSevenZipPerFileEnabled(event.target.checked)
                      if (!event.target.checked) setShowSevenZipMethodOverrides(false)
                    }}
                  />
                  <span className="compression-panel__mode-toggle-track" aria-hidden="true">
                    <span className="compression-panel__mode-toggle-thumb" />
                  </span>
                </label>
              </div>

              {!sevenZipPerFileActive && (
                <div className="compression-panel__expert-row">
                  <label className="compression-panel__expert-label" htmlFor="compression-7z-method">
                    {t('compression.codecMethod')}
                  </label>
                  <Select<SevenZipMethod>
                    id="compression-7z-method"
                    ariaLabel={t('compression.codecMethod')}
                    value={sevenZipMethod}
                    onChange={setSevenZipMethod}
                    options={[
                      { value: 'lzma2', label: t('compression.methodLzma2') },
                      { value: 'copy', label: t('compression.methodCopy') }
                    ]}
                  />
                </div>
              )}

              {sevenZipGlobalTuning && (
                <>
                  <div className="compression-panel__expert-row">
                    <label className="compression-panel__expert-label" htmlFor="compression-dictionary-size">
                      {t('compression.dictionarySize')}
                    </label>
                    <Select<number>
                      id="compression-dictionary-size"
                      ariaLabel={t('compression.dictionarySize')}
                      value={dictionarySize}
                      onChange={setDictionarySize}
                      options={DICTIONARY_SIZES}
                    />
                  </div>
                  <div className="compression-panel__expert-row">
                    <label className="compression-panel__expert-label" htmlFor="compression-match-finder-word-size">
                      {t('compression.matchFinderWordSize')}
                    </label>
                    <Select<MatchFinderWordSize>
                      id="compression-match-finder-word-size"
                      ariaLabel={t('compression.matchFinderWordSize')}
                      value={matchFinderWordSize}
                      onChange={setMatchFinderWordSize}
                      options={[32, 64, 128, 273].map(value => ({
                        value: value as MatchFinderWordSize,
                        label: String(value)
                      }))}
                    />
                  </div>
                  <div className="compression-panel__expert-row">
                    <label className="compression-panel__expert-label">{t('compression.searchCycles')} ({searchCycles})</label>
                    <input className="compression-panel__range" type="range" min="1" max="1024" value={searchCycles} onChange={(e) => setSearchCycles(Number(e.target.value))} />
                  </div>
                </>
              )}

              {(sevenZipPerFileActive || sevenZipMethod === 'lzma2') && (
                <label className="compression-panel__split-option compression-panel__split-option--nested">
                  <input
                    type="checkbox"
                    className="compression-panel__checkbox"
                    checked={solidBlock}
                    onChange={(e) => setSolidBlock(e.target.checked)}
                  />
                  <span>
                    <span className="compression-panel__option-title">{t('compression.solidArchive')}</span>
                    <span className="compression-panel__option-description">
                      {t('compression.solidArchiveHint')}
                    </span>
                  </span>
                </label>
              )}
            </>
          )}

          {/* ZIP exposes Deflate tuning in global mode and moves it into the
              per-file dialog once overrides are active. */}
          {deflateTuned && (
            <>
              <div className="compression-panel__expert-row">
                <label className="compression-panel__expert-label" htmlFor="compression-deflate-strategy">
                  {t('compression.deflateStrategy')}
                </label>
                <Select<DeflateStrategy>
                  id="compression-deflate-strategy"
                  ariaLabel={t('compression.deflateStrategy')}
                  value={deflateStrategy}
                  onChange={setDeflateStrategy}
                  options={[
                    { value: 'default', label: t('compression.strategyDefault') },
                    { value: 'filtered', label: t('compression.strategyFiltered') },
                    { value: 'huffman_only', label: t('compression.strategyHuffman') },
                    { value: 'rle', label: t('compression.strategyRle') },
                    { value: 'fixed', label: t('compression.strategyFixed') }
                  ]}
                />
              </div>

              <div className="compression-panel__expert-row">
                <label className="compression-panel__expert-label">
                  {t('compression.memLevel')} ({memLevel})
                </label>
                <input
                  type="range"
                  min="1"
                  max="9"
                  value={memLevel}
                  onChange={(e) => setMemLevel(Number(e.target.value))}
                  className="compression-panel__range"
                />
              </div>
            </>
          )}

        </div>
      )}

      {supportsPassword(format) && (
        <div className="compression-panel__field">
          {/* In expert mode the whole password section moves inside the dashed
              frame, so the algorithm sits with the password it protects. */}
          <ExpertFrame
            enabled={isExpertMode}
            title={t('compression.expertEncryptionTitle')}
            icon={<Lock size={16} />}
          >
            <label className="compression-panel__label compression-panel__label--stacked">
              {t('compression.password')} <span className="compression-panel__optional">{t('compression.optional')}</span>
            </label>
            <div className="compression-panel__password-grid">
              <input type="password" className="input-text" placeholder={t('compression.passwordPlaceholder')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <input type="password" className="input-text" placeholder={t('compression.confirmPasswordPlaceholder')} value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} autoComplete="new-password" />
            </div>
            {password && password !== passwordConfirmation && (
              <p className="compression-panel__message compression-panel__message--error">{t('compression.passwordMismatch')}</p>
            )}
            {isExpertMode && format === 'zip' && (
              <div className="compression-panel__expert-row compression-panel__expert-row--spaced">
                <label className="compression-panel__expert-label" htmlFor="compression-encryption-method">
                  {t('compression.encryptionMethod')}
                </label>
                <Select<ZipEncryptionMethod>
                  id="compression-encryption-method"
                  ariaLabel={t('compression.encryptionMethod')}
                  value={zipEncryptionMethod}
                  onChange={setZipEncryptionMethod}
                  options={[
                    { value: 'zip20', label: t('compression.zipCrypto') },
                    { value: 'aes256', label: t('compression.aes256') },
                    { value: 'aes128', label: t('compression.aes128') }
                  ]}
                />
              </div>
            )}
            {password && password === passwordConfirmation && (
              <p className="compression-panel__message">
                {t(
                  format === '7z'
                    ? 'compression.passwordNotice7z'
                    : zipEncryptionMethod === 'aes256'
                      ? 'compression.passwordNoticeZipAes'
                      : zipEncryptionMethod === 'aes128'
                        ? 'compression.passwordNoticeZipAes128'
                      : 'compression.passwordNoticeZip'
                )}
              </p>
            )}
            {isExpertMode && supportsHeaderEncryption(format) && (
              // Shown from the start; it only takes effect once a password
              // backs it, which handleCompress enforces.
              <label className="compression-panel__split-option compression-panel__split-option--nested">
                <input
                  type="checkbox"
                  className="compression-panel__checkbox"
                  checked={encryptFileNames}
                  onChange={(e) => setEncryptFileNames(e.target.checked)}
                />
                <span>
                  <span className="compression-panel__option-title">{t('compression.encryptFileNames')}</span>
                  <span className="compression-panel__option-description">
                    {t('compression.encryptFileNamesHint')}
                  </span>
                </span>
              </label>
            )}
          </ExpertFrame>
        </div>
      )}

      {supportsSplit(format) && (
        <div className="compression-panel__field">
          <label className="compression-panel__split-option">
            <input
              type="checkbox"
              className="compression-panel__checkbox"
              checked={splitEnabled}
              onChange={(e) => setSplitEnabled(e.target.checked)}
            />
            <span>
              <span className="compression-panel__option-title">{t('compression.splitEnable')}</span>
              <span className="compression-panel__option-description">
                {t(format === '7z' ? 'compression.splitExample7z' : 'compression.splitExampleZip')}
              </span>
            </span>
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
                  {(['B', 'KB', 'MB', 'GB'] as const).map((unit) => (
                    <button
                      key={unit}
                      onClick={() => setSplitCustomUnit(unit)}
                      className={`compression-panel__split-button compression-panel__split-unit${splitCustomUnit === unit ? ' is-active' : ''}`}
                    >
                      {unit}
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
        disabled={items.length === 0 || (supportsPassword(format) && password !== passwordConfirmation) || splitInvalid}
      >
        <Archive size={20} />
        {t('compression.start')}
      </button>

      {showZipMethodOverrides && isExpertMode && format === 'zip' && (
        <ZipMethodOverridesModal
          items={items}
          overrides={zipMethodOverrides}
          defaultLevel={level}
          onChange={setZipMethodOverrides}
          onClose={() => setShowZipMethodOverrides(false)}
        />
      )}
      {showSevenZipMethodOverrides && isExpertMode && format === '7z' && (
        <SevenZipMethodOverridesModal
          items={items}
          overrides={sevenZipMethodOverrides}
          defaultLevel={level}
          onChange={setSevenZipMethodOverrides}
          onClose={() => setShowSevenZipMethodOverrides(false)}
        />
      )}
    </div>
  )
}
