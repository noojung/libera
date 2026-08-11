import React, { useState, useEffect } from 'react'
import { FolderOutput, Sliders, Zap, Archive, Lock } from 'lucide-react'
import { SelectedItem } from '../types'

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
  const [format, setFormat] = useState<'zip' | 'tar' | 'gz' | 'tgz'>('zip')
  const [level, setLevel] = useState<number>(6)
  const [customName, setCustomName] = useState<string>('archive')
  const [outputPath, setOutputPath] = useState<string>('')
  const [defaultDir, setDefaultDir] = useState<string>('')
  const [password, setPassword] = useState<string>('')

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
      const chosenPath = await (window as any).electronAPI.selectSaveLocation(defaultName, format)
      if (chosenPath) {
        setOutputPath(chosenPath)
      }
    }
  }

  const getLevelLabel = (lvl: number) => {
    if (lvl === 0) return '0 - Store (Fastest, no compression)'
    if (lvl <= 3) return `${lvl} - Fast`
    if (lvl <= 6) return `${lvl} - Balanced Standard`
    return `${lvl} - Ultra (Maximum compression)`
  }

  const handleCompress = () => {
    const sep = defaultDir.includes('\\') ? '\\' : '/'
    const fallbackPath = defaultDir ? `${defaultDir}${sep}${customName}.${format}` : `${customName}.${format}`
    const finalOutput = outputPath || fallbackPath
    onStartCompress({
      format,
      level,
      outputPath: finalOutput,
      password: password || undefined
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
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#F8FAFC', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sliders size={18} color="#38BDF8" />
          Compression Settings
        </h3>
        <span style={{ fontSize: '12px', color: '#94A3B8', fontFamily: 'var(--font-mono)' }}>
          Total Uncompressed: {formatSize(totalBytes)}
        </span>
      </div>

      {/* Target Format Selector */}
      <div>
        <label style={{ fontSize: '12px', fontWeight: 600, color: '#94A3B8', marginBottom: '8px', display: 'block' }}>
          ARCHIVE FORMAT
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          {(['zip', 'tar', 'gz', 'tgz'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => setFormat(fmt)}
              style={{
                background: format === fmt ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                border: format === fmt ? '1px solid #38BDF8' : '1px solid rgba(255, 255, 255, 0.08)',
                color: format === fmt ? '#38BDF8' : '#94A3B8',
                padding: '12px',
                borderRadius: '10px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
                textAlign: 'center',
                transition: 'all 0.15s ease'
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
          <label style={{ fontSize: '12px', fontWeight: 600, color: '#94A3B8' }}>
            COMPRESSION LEVEL
          </label>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#38BDF8' }}>
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
            accentColor: '#38BDF8',
            cursor: 'pointer'
          }}
        />
      </div>

      {/* Save Destination */}
      <div>
        <label style={{ fontSize: '12px', fontWeight: 600, color: '#94A3B8', marginBottom: '6px', display: 'block' }}>
          OUTPUT DESTINATION
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input-text"
            placeholder={`Output path...`}
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSelectSavePath} style={{ whiteSpace: 'nowrap' }}>
            Browse
          </button>
        </div>
      </div>

      {/* Start Button */}
      <button
        className="btn-primary"
        onClick={handleCompress}
        disabled={items.length === 0}
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '14px',
          fontSize: '15px',
          opacity: items.length === 0 ? 0.5 : 1,
          cursor: items.length === 0 ? 'not-allowed' : 'pointer'
        }}
      >
        <Archive size={18} />
        Start Compression
      </button>
    </div>
  )
}
