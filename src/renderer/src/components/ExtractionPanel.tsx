import React, { useState, useEffect } from 'react'
import { FolderOutput, Download, Folder } from 'lucide-react'
import { SelectedItem } from '../types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'

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
    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', fontWeight: 700, color: '#362D27', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FolderOutput size={18} color="#FF8E72" />
          {t('extraction.title')}
        </h3>
        <span style={{ fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
          {t('extraction.selected', { count: items.length, size: formatBytes(totalBytes, language) })}
        </span>
      </div>

      {/* Target Directory Selector */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
          {t('extraction.destination')}
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input-text"
            placeholder={t('extraction.destinationPlaceholder')}
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSelectFolder} style={{ whiteSpace: 'nowrap' }}>
            {t('extraction.browse')}
          </button>
        </div>
      </div>


      {/* Extraction Subfolder Option */}
      <div style={{
        background: '#FAF7F2',
        padding: '14px',
        borderRadius: '12px',
        border: '1.5px solid #4A403A',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        cursor: 'pointer'
      }} onClick={() => setCreateSubfolder(!createSubfolder)}>
        <input
          type="checkbox"
          checked={createSubfolder}
          onChange={(e) => setCreateSubfolder(e.target.checked)}
          style={{ width: '18px', height: '18px', accentColor: '#FF8E72', cursor: 'pointer' }}
          onClick={(e) => e.stopPropagation()}
        />
        <div>
          <div style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27' }}>
            {t('extraction.createSubfolder')}
          </div>
          <div style={{ fontSize: '12px', color: '#6E6158' }}>
            {t('extraction.example', { directory: targetDir || t('extraction.defaultDirectory') })}
          </div>
        </div>
      </div>

      {/* Batch Overview Box */}
      <div style={{
        background: '#FFF3E4',
        padding: '14px',
        borderRadius: '12px',
        border: '1.5px solid #4A403A',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-cute)', fontSize: '14px', fontWeight: 700, color: '#362D27' }}>
          <Folder size={16} color="#FF8E72" />
          {t('extraction.summaryTitle')}
        </div>
        <p style={{ fontSize: '12px', color: '#6E6158', margin: 0, lineHeight: '1.4' }}>
          {t('extraction.summary')}
        </p>
      </div>

      {/* Action Button */}
      <button
        className="btn-primary"
        onClick={handleExtract}
        disabled={items.length === 0 || !targetDir}
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '12px',
          opacity: (items.length === 0 || !targetDir) ? 0.5 : 1,
          cursor: (items.length === 0 || !targetDir) ? 'not-allowed' : 'pointer'
        }}
      >
        <Download size={20} />
        {t('extraction.start')}
      </button>
    </div>
  )
}
