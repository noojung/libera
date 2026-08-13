import React, { useMemo, useState } from 'react'
import { ChevronRight, File, Filter, Folder, Home, Search, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'
import './ArchiveInspector.css'

interface ArchiveEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  compressedSize?: number
  ratio?: number | null
  date?: string
}

const ENTRY_PAGE_SIZE = 500

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
  const [visibleEntryCount, setVisibleEntryCount] = useState(ENTRY_PAGE_SIZE)

  const runInspection = async (filePath: string) => {
    setLoading(true)
    setErrorKey(null)
    setSearchQuery('')
    setCurrentPath('')
    setVisibleEntryCount(ENTRY_PAGE_SIZE)
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
  const allDisplayedEntries = useMemo(() => {
    const entries = isSearching ? searchableEntries : currentEntries
    if (!isSearching) return entries
    const query = normalizeSearchText(searchQuery, language)
    return entries.filter(entry =>
      normalizeSearchText(entry.name, language).includes(query) ||
      normalizeSearchText(entry.path, language).includes(query)
    )
  }, [currentEntries, isSearching, language, searchQuery, searchableEntries])
  const displayedEntries = allDisplayedEntries.slice(0, visibleEntryCount)
  const breadcrumbs = currentPath ? currentPath.split('/') : []

  const moveToPath = (nextPath: string) => {
    setCurrentPath(nextPath)
    setSearchQuery('')
    setVisibleEntryCount(ENTRY_PAGE_SIZE)
  }

  return (
    <div onDrop={handleDrop} onDragOver={handleDragOver} className="archive-inspector">
      <div className="glass-panel archive-inspector__header">
        <div className="archive-inspector__header-main">
          <div className="archive-inspector__header-icon">
            <Search size={22} />
          </div>
          <div>
            <h3 className="archive-inspector__title">
              {t('inspector.title')}
            </h3>
            <p className="archive-inspector__subtitle">
              {archivePath || t('inspector.subtitle')}
            </p>
          </div>
        </div>
        <button className="btn-secondary" onClick={handleOpenArchive}>{t('inspector.openFile')}</button>
      </div>

      {loading ? (
        <div className="glass-panel archive-inspector__state archive-inspector__state--loading">
          <span>{t('inspector.loading')}</span>
        </div>
      ) : errorKey ? (
        <div className="glass-panel archive-inspector__state archive-inspector__state--error">
          <ShieldAlert size={40} />
          <span>{t(errorKey)}</span>
        </div>
      ) : inspectData ? (
        <div className="archive-inspector__content">
          <div className="archive-inspector__stats">
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.format')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--accent">{inspectData.format}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.totalFiles')}</div><div className="archive-inspector__stat-value">{t('inspector.fileCount', { count: inspectData.totalFiles })}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.extractedSize')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--size">{inspectData.totalUncompressedSize === null ? t('inspector.unknown') : formatBytes(inspectData.totalUncompressedSize, language)}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.efficiency')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--success">{inspectData.overallRatio === null ? t('inspector.unknown') : t('inspector.savings', { ratio: inspectData.overallRatio })}</div></div>
          </div>

          <div className="glass-panel archive-inspector__browser">
            <div className="archive-inspector__breadcrumbs">
              <button type="button" aria-label={t('inspector.home')} title={t('inspector.home')} onClick={() => moveToPath('')} className="archive-inspector__home-button"><Home size={15} /></button>
              {breadcrumbs.map((segment, index) => {
                const breadcrumbPath = breadcrumbs.slice(0, index + 1).join('/')
                return <React.Fragment key={breadcrumbPath}><ChevronRight className="archive-inspector__breadcrumb-separator" size={15} /><button type="button" onClick={() => moveToPath(breadcrumbPath)} className={`archive-inspector__breadcrumb${index === breadcrumbs.length - 1 ? ' is-active' : ''}`}>{segment}</button></React.Fragment>
              })}
            </div>

            <div className="archive-inspector__toolbar">
              <div className="archive-inspector__search">
                <Filter className="archive-inspector__search-icon" size={16} />
                <input type="text" className="input-text archive-inspector__search-input" placeholder={t('inspector.searchPlaceholder')} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setVisibleEntryCount(ENTRY_PAGE_SIZE) }} />
              </div>
              <div className="archive-inspector__entry-count">{t(isSearching ? 'inspector.searchResults' : 'inspector.currentFolder', { count: allDisplayedEntries.length })}</div>
            </div>

            <div className="archive-inspector__table-header">
              <div>{t(isSearching ? 'inspector.path' : 'inspector.fileName')}</div><div className="archive-inspector__align-right">{t('inspector.originalSize')}</div><div className="archive-inspector__align-right">{t('inspector.compressedSize')}</div><div className="archive-inspector__align-right">{t('inspector.ratio')}</div>
            </div>

            <div className="archive-inspector__entries">
              {displayedEntries.map(entry => {
                const isNavigableDirectory = entry.isDirectory
                return (
                <button key={entry.path} type="button" onClick={() => isNavigableDirectory && moveToPath(normalizeArchivePath(entry.path))} disabled={!isNavigableDirectory} className={`archive-inspector__entry${isNavigableDirectory ? ' is-navigable' : ''}`}>
                  <div className="archive-inspector__entry-main">
                    {entry.isDirectory ? <Folder className="archive-inspector__entry-icon archive-inspector__entry-icon--folder" size={16} /> : <File className="archive-inspector__entry-icon archive-inspector__entry-icon--file" size={16} />}
                    <span className="archive-inspector__entry-name">{isSearching ? formatRelativeArchivePath(entry.path, currentPath) : entry.name}</span>
                    {isNavigableDirectory && <ChevronRight className="archive-inspector__entry-chevron" size={15} />}
                  </div>
                  <div className="archive-inspector__entry-size">{entry.isDirectory ? '-' : entry.size === null ? t('inspector.unknown') : formatBytes(entry.size, language)}</div>
                  <div className="archive-inspector__entry-compressed-size">{entry.compressedSize !== undefined ? formatBytes(entry.compressedSize, language) : '-'}</div>
                  <div className={`archive-inspector__entry-ratio${entry.ratio !== null && entry.ratio !== undefined && entry.ratio > 0 ? ' is-positive' : ''}`}>{entry.ratio === null || entry.ratio === undefined ? '-' : `${entry.ratio}%`}</div>
                </button>
                )
              })}
              {displayedEntries.length < allDisplayedEntries.length && (
                <button type="button" className="btn-secondary archive-inspector__load-more" onClick={() => setVisibleEntryCount(count => count + ENTRY_PAGE_SIZE)}>
                  {t('inspector.loadMore', { count: Math.min(ENTRY_PAGE_SIZE, allDisplayedEntries.length - displayedEntries.length) })}
                </button>
              )}
              {displayedEntries.length === 0 && <div className="archive-inspector__empty">{t(isSearching ? 'inspector.noSearchResults' : 'inspector.emptyFolder')}</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="glass-panel archive-inspector__state archive-inspector__state--empty">
          <Search className="archive-inspector__empty-icon" size={48} />
          <h4 className="archive-inspector__empty-title">{t('inspector.noArchive')}</h4>
          <button className="btn-primary" onClick={handleOpenArchive}>{t('inspector.selectArchive')}</button>
        </div>
      )}
    </div>
  )
}
