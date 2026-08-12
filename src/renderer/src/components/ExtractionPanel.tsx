import React, { useState, useEffect } from 'react'
import { FolderOutput, Download, Folder } from 'lucide-react'
import { SelectedItem } from '../types'

interface ExtractionPanelProps {
  items: SelectedItem[]
  onStartBatchExtract: (options: { targetDir: string; createSubfolder: boolean }) => void
}

export const ExtractionPanel: React.FC<ExtractionPanelProps> = ({ items, onStartBatchExtract }) => {
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
    const chosen = await (window as any).electronAPI.selectExtractFolder()
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
  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', fontWeight: 700, color: '#362D27', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FolderOutput size={18} color="#FF8E72" />
          배치 해제 옵션 ⚙️
        </h3>
        <span style={{ fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
          선택된 압축 파일: {items.length}개 ({formatSize(totalBytes)})
        </span>
      </div>

      {/* Target Directory Selector */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
          해제 저장 위치
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input-text"
            placeholder="압축 해제 경로 지정"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSelectFolder} style={{ whiteSpace: 'nowrap' }}>
            찾아보기
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
            압축 파일명으로 각각 하위 폴더 생성
          </div>
          <div style={{ fontSize: '12px', color: '#6E6158' }}>
            예: archive.zip ➡️ {targetDir ? targetDir : '저장폴더'}/archive/
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
          배치 해제 방식 요약
        </div>
        <p style={{ fontSize: '12px', color: '#6E6158', margin: 0, lineHeight: '1.4' }}>
          여러 압축 파일을 한 번에 빠르게 압축 해제 큐로 전송합니다. 파일 내용 미리보기가 필요한 경우 상단의 <b>Inspector</b> 탭을 이용해 주세요.
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
        일괄 해제 시작 🚀
      </button>
    </div>
  )
}
