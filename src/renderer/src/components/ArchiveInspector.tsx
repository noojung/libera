import React, { useState } from 'react'
import { Folder, File, Search, Download, ShieldAlert, CheckSquare, Square, Filter } from 'lucide-react'

interface ArchiveInspectorProps {
  onStartExtract: (archivePath: string, targetDir: string, selectedEntries?: string[]) => void
}

export const ArchiveInspector: React.FC<ArchiveInspectorProps> = ({ onStartExtract }) => {
  const [archivePath, setArchivePath] = useState<string>('')
  const [inspectData, setInspectData] = useState<any>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())

  const handleOpenArchive = async () => {
    if (!(window as any).electronAPI) return
    const files = await (window as any).electronAPI.selectFiles({ allowDirectories: false })
    if (files.length > 0) {
      const file = files[0]
      setArchivePath(file)
      runInspection(file)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      const f = files[0]
      let p = (f as any).path || f.name
      if ((window as any).electronAPI?.getPathForFile) {
        try {
          const resolved = (window as any).electronAPI.getPathForFile(f)
          if (resolved) p = resolved
        } catch {
          // fallback
        }
      }
      setArchivePath(p)
      runInspection(p)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const runInspection = async (filePath: string) => {
    setLoading(true)
    setError(null)
    setSearchQuery('')
    setSelectedPaths(new Set())
    try {
      const response = await (window as any).electronAPI.inspectArchive(filePath)
      if (response.success) {
        setInspectData(response.result)
      } else {
        setError(response.error || '압축 파일 정보를 읽는데 실패했습니다')
      }
    } catch (err: any) {
      setError(err.message || '검사 오류가 발생했습니다')
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

  const handleExtractSelected = async () => {
    if (!archivePath || selectedPaths.size === 0) return
    const targetDir = await (window as any).electronAPI.selectExtractFolder()
    if (targetDir) {
      onStartExtract(archivePath, targetDir, Array.from(selectedPaths))
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const filteredEntries = inspectData?.entries?.filter((entry: any) => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    return entry.path.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)
  }) || []

  const isAllSelected = filteredEntries.length > 0 && filteredEntries.every((e: any) => selectedPaths.has(e.path))

  const toggleSelectAll = () => {
    if (isAllSelected) {
      const updated = new Set(selectedPaths)
      filteredEntries.forEach((e: any) => updated.delete(e.path))
      setSelectedPaths(updated)
    } else {
      const updated = new Set(selectedPaths)
      filteredEntries.forEach((e: any) => updated.add(e.path))
      setSelectedPaths(updated)
    }
  }

  const toggleEntrySelect = (path: string) => {
    const updated = new Set(selectedPaths)
    if (updated.has(path)) {
      updated.delete(path)
    } else {
      updated.add(path)
    }
    setSelectedPaths(updated)
  }

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver} style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Top Header Card */}
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '44px',
            height: '44px',
            borderRadius: '50%',
            background: '#FFF3E4',
            border: '2px solid #4A403A',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '2px 2px 0px #4A403A'
          }}>
            <Search size={22} color="#FF8E72" />
          </div>
          <div>
            <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '20px', fontWeight: 700, color: '#362D27' }}>
              압축 파일 미리보기 & 검사 🔍
            </h3>
            <p style={{ fontSize: '13px', color: '#6E6158' }}>
              {archivePath ? archivePath : '압축을 해제하기 전 파일 구성 확인, 검색, 선택 해제가 가능합니다'}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-secondary" onClick={handleOpenArchive}>
            파일 열기...
          </button>
          {inspectData && selectedPaths.size > 0 && (
            <button className="btn-secondary" onClick={handleExtractSelected} style={{ background: '#FFF3E4', borderColor: '#FF8E72', color: '#FF8E72' }}>
              <Download size={16} />
              선택 항목 해제 ({selectedPaths.size}개)
            </button>
          )}
          {inspectData && (
            <button className="btn-primary" onClick={handleExtractAll}>
              <Download size={16} />
              전체 해제
            </button>
          )}
        </div>
      </div>

      {/* Main Inspection View */}
      {loading ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#FF8E72', fontWeight: 700 }}>
            압축 파일 헤더 분석 중... 🐶
          </span>
        </div>
      ) : error ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
          <ShieldAlert size={40} color="#E76F51" />
          <span style={{ fontSize: '15px', color: '#E76F51', fontWeight: 600 }}>{error}</span>
        </div>
      ) : inspectData ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
          {/* Stats Bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>포맷</div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#FF8E72', marginTop: '2px' }}>{inspectData.format}</div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>총 파일 수</div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#362D27', marginTop: '2px' }}>{inspectData.totalFiles}개</div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>해제 시 용량</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#362D27', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                {formatSize(inspectData.totalUncompressedSize)}
              </div>
            </div>

            <div className="glass-panel" style={{ padding: '12px' }}>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>압축 효율</div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#52B788', marginTop: '2px' }}>
                {inspectData.overallRatio}% 절감
              </div>
            </div>
          </div>

          {/* Table Control / Filter Bar */}
          <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={16} color="#FF8E72" />
                <input
                  type="text"
                  className="input-text"
                  placeholder="파일 이름 또는 경로 검색..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ width: '260px', padding: '6px 12px', fontSize: '13px' }}
                />
              </div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>
                {selectedPaths.size > 0 ? `${selectedPaths.size}개 항목 선택됨` : `전체 ${filteredEntries.length}개 표시`}
              </div>
            </div>

            {/* Entries Table Header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '40px 2fr 1fr 1fr 1fr',
              paddingBottom: '8px',
              borderBottom: '2px solid #4A403A',
              fontFamily: 'var(--font-cute)',
              fontSize: '15px',
              fontWeight: 700,
              color: '#362D27',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={toggleSelectAll}>
                {isAllSelected ? <CheckSquare size={18} color="#FF8E72" /> : <Square size={18} color="#A3968C" />}
              </div>
              <div>파일명 / 경로</div>
              <div style={{ textAlign: 'right' }}>원본 용량</div>
              <div style={{ textAlign: 'right' }}>압축 용량</div>
              <div style={{ textAlign: 'right' }}>절감율</div>
            </div>

            {/* Entries List */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {filteredEntries.map((entry: any) => {
                const isSelected = selectedPaths.has(entry.path)
                return (
                  <div
                    key={entry.id}
                    onClick={() => toggleEntrySelect(entry.path)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '40px 2fr 1fr 1fr 1fr',
                      padding: '10px 0',
                      borderBottom: '1px dashed #E8DFD5',
                      alignItems: 'center',
                      fontSize: '13px',
                      background: isSelected ? '#FFF8F0' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {isSelected ? <CheckSquare size={18} color="#FF8E72" /> : <Square size={18} color="#A3968C" />}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                      {entry.isDirectory ? <Folder size={16} color="#FF8E72" /> : <File size={16} color="#5A9EED" />}
                      <span style={{ color: '#362D27', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {entry.path}
                      </span>
                    </div>

                    <div style={{ textAlign: 'right', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                      {formatSize(entry.size)}
                    </div>

                    <div style={{ textAlign: 'right', color: '#A3968C', fontFamily: 'var(--font-mono)' }}>
                      {entry.compressedSize ? formatSize(entry.compressedSize) : '-'}
                    </div>

                    <div style={{ textAlign: 'right', color: entry.ratio > 0 ? '#52B788' : '#6E6158', fontWeight: 600 }}>
                      {entry.ratio ? `${entry.ratio}%` : '-'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <Search size={48} color="#D9CEC1" />
          <h4 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#6E6158' }}>선택된 압축 파일이 없습니다</h4>
          <button className="btn-primary" onClick={handleOpenArchive}>
            압축 파일 선택하기
          </button>
        </div>
      )}
    </div>
  )
}
