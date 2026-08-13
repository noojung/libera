import React, { useMemo, useState } from 'react'
import { ChevronRight, File, Filter, Folder, Home, Search, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'

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

function normalizeSearchText(value: string, language: AppLanguage): string {
  return value.normalize('NFC').toLocaleLowerCase(language)
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

function getDirectChildren(entries: ArchiveEntry[], currentPath: string, language: AppLanguage): ArchiveBrowserEntry[] {
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
    return left.name.localeCompare(right.name, language)
  })
}

export const ArchiveInspector: React.FC = () => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [archivePath, setArchivePath] = useState<string>('')
  const [inspectData, setInspectData] = useState<{ entries: ArchiveEntry[]; [key: string]: any } | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [currentPath, setCurrentPath] = useState<string>('')

  const runInspection = async (filePath: string) => {
    setLoading(true)
    setErrorKey(null)
    setSearchQuery('')
    setCurrentPath('')
    try {
      const response = await (window as any).electronAPI.inspectArchive(filePath)
      if (response.success) {
        setInspectData(response.result)
      } else {
        setInspectData(null)
        setErrorKey(response.errorCode ? `errors.${response.errorCode}` : 'inspector.readFailed')
      }
    } catch (err: any) {
      setInspectData(null)
      console.error('Archive inspection failed:', err)
      setErrorKey('inspector.inspectFailed')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenArchive = async () => {
    if (!(window as any).electronAPI) return
    const files = await (window as any).electronAPI.selectFiles({
      allowDirectories: false,
      extensions: ['zip', 'tar', 'tgz', 'gz'],
      title: t('dialogs.selectExtractInputs'),
      filterName: t('dialogs.supportedArchives')
    })
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

  const currentEntries = useMemo(
    () => getDirectChildren(inspectData?.entries || [], currentPath, language),
    [inspectData, currentPath, language]
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
    const query = normalizeSearchText(searchQuery, language)
    return normalizeSearchText(entry.name, language).includes(query) || normalizeSearchText(entry.path, language).includes(query)
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
              {t('inspector.title')}
            </h3>
            <p style={{ fontSize: '13px', color: '#6E6158' }}>
              {archivePath || t('inspector.subtitle')}
            </p>
          </div>
        </div>
        <button className="btn-secondary" onClick={handleOpenArchive}>{t('inspector.openFile')}</button>
      </div>

      {loading ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#FF8E72', fontWeight: 700 }}>{t('inspector.loading')}</span>
        </div>
      ) : errorKey ? (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
          <ShieldAlert size={40} color="#E76F51" />
          <span style={{ fontSize: '15px', color: '#E76F51', fontWeight: 600 }}>{t(errorKey)}</span>
        </div>
      ) : inspectData ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{t('inspector.format')}</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#FF8E72', marginTop: '2px' }}>{inspectData.format}</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{t('inspector.totalFiles')}</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#362D27', marginTop: '2px' }}>{t('inspector.fileCount', { count: inspectData.totalFiles })}</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{t('inspector.extractedSize')}</div><div style={{ fontSize: '16px', fontWeight: 700, color: '#362D27', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>{formatBytes(inspectData.totalUncompressedSize, language)}</div></div>
            <div className="glass-panel" style={{ padding: '12px' }}><div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{t('inspector.efficiency')}</div><div style={{ fontFamily: 'var(--font-cute)', fontSize: '22px', fontWeight: 700, color: '#52B788', marginTop: '2px' }}>{t('inspector.savings', { ratio: inspectData.overallRatio })}</div></div>
          </div>

          <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '32px', marginBottom: '12px', color: '#6E6158', fontSize: '13px' }}>
              <button type="button" aria-label={t('inspector.home')} title={t('inspector.home')} onClick={() => moveToPath('')} style={{ background: 'transparent', border: 'none', color: '#362D27', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 700 }}><Home size={15} /></button>
              {breadcrumbs.map((segment, index) => {
                const breadcrumbPath = breadcrumbs.slice(0, index + 1).join('/')
                return <React.Fragment key={breadcrumbPath}><ChevronRight size={15} color="#A3968C" /><button type="button" onClick={() => moveToPath(breadcrumbPath)} style={{ background: 'transparent', border: 'none', color: index === breadcrumbs.length - 1 ? '#FF8E72' : '#362D27', cursor: 'pointer', fontWeight: index === breadcrumbs.length - 1 ? 700 : 500 }}>{segment}</button></React.Fragment>
              })}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={16} color="#FF8E72" />
                <input type="text" className="input-text" placeholder={t('inspector.searchPlaceholder')} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} style={{ width: '260px', padding: '6px 12px', fontSize: '13px' }} />
              </div>
              <div style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158', fontWeight: 700 }}>{t(isSearching ? 'inspector.searchResults' : 'inspector.currentFolder', { count: displayedEntries.length })}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', paddingBottom: '8px', borderBottom: '2px solid #4A403A', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27' }}>
              <div>{t(isSearching ? 'inspector.path' : 'inspector.fileName')}</div><div style={{ textAlign: 'right' }}>{t('inspector.originalSize')}</div><div style={{ textAlign: 'right' }}>{t('inspector.compressedSize')}</div><div style={{ textAlign: 'right' }}>{t('inspector.ratio')}</div>
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
                  <div style={{ textAlign: 'right', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>{entry.isDirectory ? '-' : formatBytes(entry.size, language)}</div>
                  <div style={{ textAlign: 'right', color: '#A3968C', fontFamily: 'var(--font-mono)' }}>{entry.compressedSize !== undefined ? formatBytes(entry.compressedSize, language) : '-'}</div>
                  <div style={{ textAlign: 'right', color: entry.ratio && entry.ratio > 0 ? '#52B788' : '#6E6158', fontWeight: 600 }}>{entry.ratio ? `${entry.ratio}%` : '-'}</div>
                </button>
                )
              })}
              {displayedEntries.length === 0 && <div style={{ padding: '28px', textAlign: 'center', color: '#6E6158', fontSize: '13px' }}>{t(isSearching ? 'inspector.noSearchResults' : 'inspector.emptyFolder')}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
          <Search size={48} color="#D9CEC1" />
          <h4 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#6E6158' }}>{t('inspector.noArchive')}</h4>
          <button className="btn-primary" onClick={handleOpenArchive}>{t('inspector.selectArchive')}</button>
        </div>
      )}
    </div>
  )
}
