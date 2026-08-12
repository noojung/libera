import React, { useMemo, useState } from 'react'
import { ChevronRight, File, Filter, Folder, Home, Search, ShieldAlert } from 'lucide-react'

interface ArchiveEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number
  compressedSize?: number
  ratio?: number
  date?: string
}

interface ArchiveBrowserEntry extends ArchiveEntry {
  isVirtual?: boolean
}

function normalizeArchivePath(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ko-KR')
}

function formatArchivePath(entryPath: string): string {
  return normalizeArchivePath(entryPath).split('/').join(' > ')
}

function formatRelativeArchivePath(entryPath: string, currentPath: string): string {
  const normalizedPath = normalizeArchivePath(entryPath)
  const currentPrefix = currentPath ? `${currentPath}/` : ''
  const relativePath = currentPrefix && normalizedPath.startsWith(currentPrefix)
    ? normalizedPath.slice(currentPrefix.length)
    : normalizedPath
  return formatArchivePath(relativePath)
}

function getDirectChildren(entries: ArchiveEntry[], currentPath: string): ArchiveBrowserEntry[] {
  const children = new Map<string, ArchiveBrowserEntry>()
  const currentPrefix = currentPath ? `${currentPath}/` : ''

  for (const entry of entries) {
    const normalizedPath = normalizeArchivePath(entry.path)
    if (!normalizedPath || (currentPrefix && !normalizedPath.startsWith(currentPrefix))) continue

    const remainingPath = currentPrefix ? normalizedPath.slice(currentPrefix.length) : normalizedPath
    if (!remainingPath) continue

    const [name, ...descendants] = remainingPath.split('/')
    const childPath = currentPrefix ? `${currentPrefix}${name}` : name

    if (descendants.length > 0) {
      if (!children.has(childPath)) {
        children.set(childPath, {
          id: `folder-${childPath}`,
          name,
          path: childPath,
          isDirectory: true,
          size: 0,
          isVirtual: true
        })
      }
      continue
    }

    children.set(childPath, {
      ...entry,
      name: entry.name || name,
      path: childPath
    })
  }

  return Array.from(children.values()).sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export const ArchiveInspector: React.FC = () => {
  const [archivePath, setArchivePath] = useState<string>('')
  const [inspectData, setInspectData] = useState<{ entries: ArchiveEntry[]; [key: string]: any } | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [currentPath, setCurrentPath] = useState<string>('')

  const runInspection = async (filePath: string) => {
    setLoading(true)
    setError(null)
    setSearchQuery('')
    setCurrentPath('')
    try {
      const response = await (window as any).electronAPI.inspectArchive(filePath)
      if (response.success) {
        setInspectData(response.result)
      } else {
        setInspectData(null)
        setError(response.error || '압축 파일 정보를 읽는데 실패했습니다')
      }
    } catch (err: any) {
      setInspectData(null)
      setError(err.message || '검사 오류가 발생했습니다')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenArchive = async () => {
    if (!(window as any).electronAPI) return
    const files = await (window as any).electronAPI.selectFiles({ allowDirectories: false })
    if (files.length > 0) {
      const file = files[0]
      setArchivePath(file)
      runInspection(file)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return

    const file = files[0]
    let filePath = (file as any).path || file.name
    if ((window as any).electronAPI?.getPathForFile) {
      try {
        filePath = (window as any).electronAPI.getPathForFile(file) || filePath
      } catch {
        // Use the path supplied by the browser when Electron does not provide one.
      }
    }
    setArchivePath(filePath)
    runInspection(filePath)
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${parseFloat((bytes / Math.pow(1024, unitIndex)).toFixed(2))} ${units[unitIndex]}`
  }

  const currentEntries = useMemo(
    () => getDirectChildren(inspectData?.entries || [], currentPath),
    [inspectData, currentPath]
  )
  const isSearching = Boolean(searchQuery.trim())
  const searchableEntries = useMemo(() => {
    const currentPrefix = currentPath ? `${currentPath}/` : ''
    return (inspectData?.entries || []).filter(entry => {
      const normalizedPath = normalizeArchivePath(entry.path)
      return !currentPrefix || normalizedPath.startsWith(currentPrefix)
    })
  }, [inspectData, currentPath])
  const displayedEntries = (isSearching ? searchableEntries : currentEntries).filter(entry => {
    if (!isSearching) return true
    const query = normalizeSearchText(searchQuery)
    return normalizeSearchText(entry.name).includes(query) || normalizeSearchText(entry.path).includes(query)
  })
  const breadcrumbs = currentPath ? currentPath.split('/') : []

  const moveToPath = (nextPath: string) => {
    setCurrentPath(nextPath)
    setSearchQuery('')
  }

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver} style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: '#FFF3E4', border: '2px solid #4A403A', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '2px 2px 0px #4A403A' }}>
            <Search size={22} color="#FF8E72" />
          </div>
          <div>
            <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '20px', fontWeight: 700, color: '#362D27' }}>
              압축 파일 미리보기 & 검사 🔍
            </h3>
            <p style={{ fontSize: '13px', color: '#6E6158' }}>
              {archivePath || '압축 파일의 구성과 폴더를 탐색할 수 있습니다'}
            </p>
          </div>
        </div>
        <button className="btn-secondary" onClick={handleOpenArchive}>파일 열기...</button>
      </div>

      {loading ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#FF8E72', fontWeight: 700 }}>압축 파일 헤더 분석 중... 🐶</span>
        </div>
      ) : error ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
          <ShieldAlert size={40} color="#E76F51" />
          <span style={{ fontSize: '15px', color: '#E76F51', fontWeight: 600 }}>{error}</span>
        </div>
      ) : inspectData ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>포맷</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#FF8E72', marginTop: '2px' }}>{inspectData.format}</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>총 파일 수</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#362D27', marginTop: '2px' }}>{inspectData.totalFiles}개</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>해제 시 용량</div><div style={{ fontSize: '16px', fontWeight: 700, color: '#362D27', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>{formatSize(inspectData.totalUncompressedSize)}</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>압축 효율</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#52B788', marginTop: '2px' }}>{inspectData.overallRatio}% 절감</div></div>
          </div>

          <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '32px', marginBottom: '12px', color: '#6E6158', fontSize: '13px' }}>
              <button type="button" onClick={() => moveToPath('')} style={{ background: 'transparent', border: 'none', color: '#362D27', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}><Home size={15} /></button>
              {breadcrumbs.map((segment, index) => {
                const breadcrumbPath = breadcrumbs.slice(0, index + 1).join('/')
                return <React.Fragment key={breadcrumbPath}><ChevronRight size={15} color="#A3968C" /><button type="button" onClick={() => moveToPath(breadcrumbPath)} style={{ background: 'transparent', border: 'none', color: index === breadcrumbs.length - 1 ? '#FF8E72' : '#362D27', cursor: 'pointer', fontWeight: index === breadcrumbs.length - 1 ? 700 : 500 }}>{segment}</button></React.Fragment>
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={16} color="#FF8E72" />
                <input type="text" className="input-text" placeholder="현재 폴더와 하위 폴더에서 검색..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} style={{ width: '260px', padding: '6px 12px', fontSize: '13px' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{isSearching ? `현재 폴더 내 검색 결과: ${displayedEntries.length}개` : `현재 폴더: ${displayedEntries.length}개`}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', paddingBottom: '8px', borderBottom: '2px solid #4A403A', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27' }}>
              <div>{isSearching ? '경로' : '파일명'}</div><div style={{ textAlign: 'right' }}>원본 용량</div><div style={{ textAlign: 'right' }}>압축 용량</div><div style={{ textAlign: 'right' }}>절감율</div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {displayedEntries.map(entry => {
                const isNavigableDirectory = entry.isDirectory
                return (
                <button key={entry.path} type="button" onClick={() => isNavigableDirectory && moveToPath(normalizeArchivePath(entry.path))} disabled={!isNavigableDirectory} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '10px 0', border: 'none', borderBottom: '1px dashed #E8DFD5', alignItems: 'center', fontSize: '13px', background: 'transparent', cursor: isNavigableDirectory ? 'pointer' : 'default', textAlign: 'left', color: '#362D27' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                    {entry.isDirectory ? <Folder size={16} color="#FF8E72" /> : <File size={16} color="#5A9EED" />}
                    <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{isSearching ? formatRelativeArchivePath(entry.path, currentPath) : entry.name}</span>
                    {isNavigableDirectory && <ChevronRight size={15} color="#A3968C" />}
                  </div>
                  <div style={{ textAlign: 'right', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>{entry.isDirectory ? '-' : formatSize(entry.size)}</div>
                  <div style={{ textAlign: 'right', color: '#A3968C', fontFamily: 'var(--font-mono)' }}>{entry.compressedSize !== undefined ? formatSize(entry.compressedSize) : '-'}</div>
                  <div style={{ textAlign: 'right', color: entry.ratio && entry.ratio > 0 ? '#52B788' : '#6E6158', fontWeight: 600 }}>{entry.ratio ? `${entry.ratio}%` : '-'}</div>
                </button>
                )
              })}
              {displayedEntries.length === 0 && <div style={{ padding: '28px', textAlign: 'center', color: '#6E6158', fontSize: '13px' }}>{isSearching ? '검색 결과가 없습니다.' : '이 폴더에는 표시할 항목이 없습니다.'}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <Search size={48} color="#D9CEC1" />
          <h4 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#6E6158' }}>선택된 압축 파일이 없습니다</h4>
          <button className="btn-primary" onClick={handleOpenArchive}>압축 파일 선택하기</button>
        </div>
      )}
    </div>
  )
}
