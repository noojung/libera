import React, { useState, useEffect } from 'react'
import { FolderOutput, Download } from 'lucide-react'
import { SelectedItem } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import './ExtractionPanel.css'

interface ExtractionPanelProps {
  items: SelectedItem[]
  onStartBatchExtract: (options: { targetDir: string; createSubfolder: boolean }) => void
}

export const ExtractionPanel: React.FC<ExtractionPanelProps> = ({ items, onStartBatchExtract }) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [targetDir, setTargetDir] = useState<string>('')
  const [createSubfolder, setCreateSubfolder] = useState<boolean>(true)

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
      createSubfolder
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
