import React, { useState, useEffect } from 'react'
import { FolderOutput, Download, PackageOpen } from 'lucide-react'
import { SelectedItem } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { useExpertMode } from '@/utils/expertMode'
import type { FilenameEncoding, OverwritePolicy } from '@services/extractor'
import { Select } from './Select'
import './ExtractionPanel.css'

export interface StartBatchExtractOptions {
  targetDir: string
  createSubfolder: boolean
  encoding?: FilenameEncoding
  overwritePolicy?: OverwritePolicy
  restoreTimestamps?: boolean
  restorePermissions?: boolean
  restoreSymlinks?: boolean
  excludeMacMetadata?: boolean
  strictCrc?: boolean
  filterPattern?: string
}

interface ExtractionPanelProps {
  items: SelectedItem[]
  onStartBatchExtract: (options: StartBatchExtractOptions) => void
}

export const ExtractionPanel: React.FC<ExtractionPanelProps> = ({ items, onStartBatchExtract }) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [isExpertMode] = useExpertMode()
  const canRestoreSymlinks = (window as any).electronAPI?.platform !== 'windows'

  const [targetDir, setTargetDir] = useState<string>('')
  const [createSubfolder, setCreateSubfolder] = useState<boolean>(true)

  // Expert options state
  const [encoding, setEncoding] = useState<FilenameEncoding>('auto')
  const [overwritePolicy, setOverwritePolicy] = useState<OverwritePolicy>('overwrite')
  const [restoreTimestamps, setRestoreTimestamps] = useState<boolean>(true)
  const [restorePermissions, setRestorePermissions] = useState<boolean>(true)
  const [restoreSymlinks, setRestoreSymlinks] = useState<boolean>(false)
  const [excludeMacMetadata, setExcludeMacMetadata] = useState<boolean>(false)
  const [strictCrc, setStrictCrc] = useState<boolean>(true)
  const [filterPattern, setFilterPattern] = useState<string>('')

  useEffect(() => {
    if ((window as any).electronAPI?.getDefaultOutputDir) {
      (window as any).electronAPI.getDefaultOutputDir().then((dir: string) => {
        if (dir) setTargetDir(dir)
      })
    }
  }, [])

  const handleSelectFolder = async () => {
    if (!(window as any).electronAPI) return
    const chosen = await (window as any).electronAPI.selectExtractFolder(t('dialogs.selectExtractionDestination'))
    if (chosen) {
      setTargetDir(chosen)
    }
  }

  const handleExtract = () => {
    if (!targetDir || items.length === 0) return
    onStartBatchExtract({
      targetDir,
      createSubfolder,
      ...(isExpertMode
        ? {
            encoding,
            overwritePolicy,
            restoreTimestamps,
            restorePermissions,
            restoreSymlinks,
            excludeMacMetadata,
            strictCrc,
            filterPattern: filterPattern.trim() || undefined
          }
        : {})
    })
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  return (
    <div className="glass-panel extraction-panel">
      <div className="extraction-panel__header">
        <h3 className="extraction-panel__title">
          <FolderOutput className="extraction-panel__title-icon" size={18} />
          {t('extraction.title')}
        </h3>
        <span className="extraction-panel__summary">
          {t('extraction.selected', { count: items.length, size: formatBytes(totalBytes, language) })}
        </span>
      </div>

      {/* Target Directory Selector */}
      <div className="extraction-panel__field">
        <label className="extraction-panel__label">
          {t('extraction.destination')}
        </label>
        <div className="extraction-panel__destination-row">
          <input
            type="text"
            className="input-text"
            placeholder={t('extraction.destinationPlaceholder')}
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
          />
          <button className="btn-secondary extraction-panel__browse-button" onClick={handleSelectFolder}>
            {t('extraction.browse')}
          </button>
        </div>
      </div>

      {/* Extraction Subfolder Option */}
      <div className="extraction-panel__subfolder-option" onClick={() => setCreateSubfolder(!createSubfolder)}>
        <input
          type="checkbox"
          checked={createSubfolder}
          onChange={(e) => setCreateSubfolder(e.target.checked)}
          className="extraction-panel__checkbox"
          onClick={(e) => e.stopPropagation()}
        />
        <div>
          <div className="extraction-panel__option-title">
            {t('extraction.createSubfolder')}
          </div>
          <div className="extraction-panel__option-description">
            {t('extraction.example', { directory: targetDir || t('extraction.defaultDirectory') })}
          </div>
        </div>
      </div>

      {/* Expert Mode Settings Card */}
      {isExpertMode && (
        <div className="expert-card">
          <div className="expert-card__header">
            <div className="expert-card__title">
              <PackageOpen size={16} />
              {t('extraction.expertTitle')}
            </div>
          </div>

          {/* Character Encoding Selector */}
          <div className="extraction-panel__expert-row">
            <label className="extraction-panel__expert-label" htmlFor="extraction-filename-encoding">
              {t('extraction.encoding')}
            </label>
            <Select<FilenameEncoding>
              id="extraction-filename-encoding"
              ariaLabel={t('extraction.encoding')}
              value={encoding}
              onChange={setEncoding}
              options={[
                { value: 'auto', label: t('extraction.encodingAuto') },
                { value: 'utf-8', label: t('extraction.encodingUtf8') },
                { value: 'cp949', label: t('extraction.encodingCp949') },
                { value: 'shift_jis', label: t('extraction.encodingShiftJis') },
                { value: 'gbk', label: t('extraction.encodingGbk') },
                { value: 'big5', label: t('extraction.encodingBig5') },
                { value: 'windows-1252', label: t('extraction.encodingWin1252') },
                { value: 'cp437', label: t('extraction.encodingCp437') }
              ]}
            />
          </div>

          {/* Overwrite Policy */}
          <div className="extraction-panel__expert-row">
            <label className="extraction-panel__expert-label" htmlFor="extraction-overwrite-policy">
              {t('extraction.overwritePolicy')}
            </label>
            <Select<OverwritePolicy>
              id="extraction-overwrite-policy"
              ariaLabel={t('extraction.overwritePolicy')}
              value={overwritePolicy}
              onChange={setOverwritePolicy}
              options={[
                { value: 'overwrite', label: t('extraction.overwriteAlways') },
                { value: 'skip', label: t('extraction.overwriteSkip') }
              ]}
            />
          </div>

          {/* Attributes & Safety Checkboxes */}
          <div className="extraction-panel__expert-checkboxes">
            <label className="extraction-panel__checkbox-row">
              <input
                type="checkbox"
                className="extraction-panel__checkbox"
                checked={restoreTimestamps}
                onChange={(e) => setRestoreTimestamps(e.target.checked)}
              />
              <span>{t('extraction.restoreTimestamps')}</span>
            </label>

            <label className="extraction-panel__checkbox-row">
              <input
                type="checkbox"
                className="extraction-panel__checkbox"
                checked={restorePermissions}
                onChange={(e) => setRestorePermissions(e.target.checked)}
              />
              <span>{t('extraction.restorePermissions')}</span>
            </label>

            <label
              className="extraction-panel__checkbox-row"
              title={canRestoreSymlinks ? undefined : t('extraction.restoreSymlinksUnavailable')}
            >
              <input
                type="checkbox"
                className="extraction-panel__checkbox"
                checked={restoreSymlinks}
                disabled={!canRestoreSymlinks}
                onChange={(e) => setRestoreSymlinks(e.target.checked)}
              />
              <span>{t('extraction.restoreSymlinks')}</span>
            </label>

            <label className="extraction-panel__checkbox-row">
              <input
                type="checkbox"
                className="extraction-panel__checkbox"
                checked={excludeMacMetadata}
                onChange={(e) => setExcludeMacMetadata(e.target.checked)}
              />
              <span>{t('extraction.stripMacMetadata')}</span>
            </label>

            <label className="extraction-panel__checkbox-row">
              <input
                type="checkbox"
                className="extraction-panel__checkbox"
                checked={strictCrc}
                onChange={(e) => setStrictCrc(e.target.checked)}
              />
              <span>{t('extraction.crcCheck')}</span>
            </label>
          </div>

          {/* Optional Filter Pattern */}
          <div className="extraction-panel__expert-row extraction-panel__expert-row--filter">
            <label className="extraction-panel__expert-label">
              {t('extraction.filterPattern')}
            </label>
            <input
              type="text"
              className="input-text"
              placeholder={t('extraction.filterPatternPlaceholder')}
              value={filterPattern}
              onChange={(e) => setFilterPattern(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Action Button */}
      <button
        className="btn-primary extraction-panel__start-button"
        onClick={handleExtract}
        disabled={items.length === 0 || !targetDir}
      >
        <Download size={20} />
        {t('extraction.start')}
      </button>
    </div>
  )
}
