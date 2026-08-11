import React, { useState } from 'react'
import { Folder, File, Search, Download, ArrowUpRight, CheckCircle2, ShieldAlert } from 'lucide-react'

interface ArchiveInspectorProps {
  onStartExtract: (archivePath: string, targetDir: string) => void
}

export const ArchiveInspector: React.FC<ArchiveInspectorProps> = ({ onStartExtract }) => {
  const [archivePath, setArchivePath] = useState<string>('')
  const [inspectData, setInspectData] = useState<any>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpenArchive = async () => {
    if (!(window as any).electronAPI) return
    const files = await (window as any).electronAPI.selectFiles({ allowDirectories: false })
    if (files.length > 0) {
      const file = files[0]
      setArchivePath(file)
      runInspection(file)
    }
  }

  const runInspection = async (filePath: string) => {
    setLoading(true)
    setError(null)
    try {
      const response = await (window as any).electronAPI.inspectArchive(filePath)
      if (response.success) {
        setInspectData(response.result)
      } else {
        setError(response.error || 'Failed to inspect archive')
      }
    } catch (err: any) {
      setError(err.message || 'Inspection error')
    } finally {
      setLoading(false)
    }
  }

  const handleExtractAll = async () => {
    if (!archivePath) return
    const targetDir = await (window as any).electronAPI.selectExtractFolder()
    if (targetDir) {
      onStartExtract(archivePath, targetDir)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Top Header Card */}
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            background: 'rgba(245, 158, 11, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px solid rgba(245, 158, 11, 0.3)'
          }}>
            <Search size={20} color="#F59E0B" />
          </div>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#F8FAFC' }}>
              Archive File Inspector
            </h3>
            <p style={{ fontSize: '12px', color: '#94A3B8' }}>
              {archivePath ? archivePath : 'Open any .zip, .tar, or .gz file to inspect contents without extracting'}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-secondary" onClick={handleOpenArchive}>
            Open Archive...
          </button>
          {inspectData && (
            <button className="btn-primary" onClick={handleExtractAll}>
              <Download size={16} />
              Extract All
            </button>
          )}
        </div>
      </div>

      {/* Main Inspection View */}
      {loading ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '14px', color: '#38BDF8' }}>Analyzing archive headers...</span>
        </div>
      ) : error ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
          <ShieldAlert size={36} color="#EF4444" />
          <span style={{ fontSize: '14px', color: '#EF4444', fontWeight: 600 }}>{error}</span>
        </div>
      ) : inspectData ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Stats Bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600 }}>FORMAT</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#38BDF8', marginTop: '4px' }}>{inspectData.format}</div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600 }}>TOTAL FILES</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#F8FAFC', marginTop: '4px' }}>{inspectData.totalFiles}</div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600 }}>UNCOMPRESSED SIZE</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#F8FAFC', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                {formatSize(inspectData.totalUncompressedSize)}
              </div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 600 }}>SPACE SAVED</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#10B981', marginTop: '4px' }}>
                {inspectData.overallRatio}%
              </div>
            </div>
          </div>

          {/* Entries Table */}
          <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr 1fr',
              paddingBottom: '8px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: '11px',
              fontWeight: 600,
              color: '#64748B'
            }}>
              <div>FILE / PATH</div>
              <div style={{ textAlign: 'right' }}>SIZE</div>
              <div style={{ textAlign: 'right' }}>COMPRESSED</div>
              <div style={{ textAlign: 'right' }}>SAVINGS</div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {inspectData.entries.map((entry: any) => (
                <div
                  key={entry.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr 1fr 1fr',
                    padding: '10px 0',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                    alignItems: 'center',
                    fontSize: '13px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                    {entry.isDirectory ? <Folder size={16} color="#818CF8" /> : <File size={16} color="#38BDF8" />}
                    <span style={{ color: '#F8FAFC', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {entry.path}
                    </span>
                  </div>

                  <div style={{ textAlign: 'right', color: '#94A3B8', fontFamily: 'var(--font-mono)' }}>
                    {formatSize(entry.size)}
                  </div>

                  <div style={{ textAlign: 'right', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
                    {entry.compressedSize ? formatSize(entry.compressedSize) : '-'}
                  </div>

                  <div style={{ textAlign: 'right', color: entry.ratio > 0 ? '#10B981' : '#64748B', fontWeight: 600 }}>
                    {entry.ratio ? `${entry.ratio}%` : '-'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <Search size={48} color="rgba(255, 255, 255, 0.15)" />
          <h4 style={{ fontSize: '15px', color: '#94A3B8' }}>No Archive Selected</h4>
          <button className="btn-primary" onClick={handleOpenArchive}>
            Select Archive File
          </button>
        </div>
      )}
    </div>
  )
}
