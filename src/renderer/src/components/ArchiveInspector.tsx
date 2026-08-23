import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File, Files, Filter, Folder, Home, Search, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchiveEntry, ArchiveInspectionResult } from '@services/archiveInspector'
import type { ArchivePreviewResult } from '@services/archivePreview'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { EXTRACT_DIALOG_EXTENSIONS, isSupportedArchivePath } from '@/utils/archivePaths'
import { ArchivePreviewModal } from './ArchivePreviewModal'
import { PasswordPromptModal } from './PasswordPromptModal'
import './ArchiveInspector.css'

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
  const [inspectData, setInspectData] = useState<ArchiveInspectionResult | null>(null)
  const [volumesExpanded, setVolumesExpanded] = useState(false)
  const [loading, setLoading] = useState<boolean>(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [currentPath, setCurrentPath] = useState<string>('')
  const [visibleEntryCount, setVisibleEntryCount] = useState(ENTRY_PAGE_SIZE)
  const [previewEntry, setPreviewEntry] = useState<ArchiveEntry | null>(null)
  const [previewResult, setPreviewResult] = useState<ArchivePreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErrorKey, setPreviewErrorKey] = useState<string | null>(null)
  // Held for the life of one archive: a header-encrypted 7z needs it to list,
  // and every preview of an encrypted entry needs it again.
  const [archivePassword, setArchivePassword] = useState<string | undefined>(undefined)
  // The prompt serves two callers: an archive whose listing is encrypted, and
  // an entry inside a ZIP whose central directory read fine without a password.
  const [passwordPrompt, setPasswordPrompt] = useState<
    | { target: 'listing'; path: string; incorrect: boolean }
    | { target: 'entry'; path: string; entry: ArchiveEntry; incorrect: boolean }
    | null
  >(null)
  const previewRequestSequence = useRef(0)
  const activePreviewRequest = useRef<string | null>(null)

  const closePreview = () => {
    const requestId = activePreviewRequest.current
    activePreviewRequest.current = null
    if (requestId) void (window as any).electronAPI?.cancelArchivePreview(requestId)
    setPreviewEntry(null)
    setPreviewResult(null)
    setPreviewLoading(false)
    setPreviewErrorKey(null)
  }

  useEffect(() => () => {
    const requestId = activePreviewRequest.current
    activePreviewRequest.current = null
    if (requestId) void (window as any).electronAPI?.cancelArchivePreview(requestId)
  }, [])

  const runInspection = async (filePath: string, password?: string) => {
    closePreview()
    setLoading(true)
    setErrorKey(null)
    setSearchQuery('')
    setCurrentPath('')
    setVisibleEntryCount(ENTRY_PAGE_SIZE)
    setVolumesExpanded(false)
    try {
      const response = await (window as any).electronAPI.inspectArchive(filePath, password)
      if (response.success) {
        setInspectData(response.result)
        setArchivePath(response.result.archivePath || filePath)
        setArchivePassword(password)
        setPasswordPrompt(null)
      } else if (response.code === 'PASSWORD_REQUIRED' || response.code === 'WRONG_ZIP_PASSWORD') {
        // The listing itself is encrypted, so there is nothing to show until
        // a password arrives.
        setInspectData(null)
        setPasswordPrompt({ target: 'listing', path: filePath, incorrect: response.code === 'WRONG_ZIP_PASSWORD' })
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
      extensions: EXTRACT_DIALOG_EXTENSIONS,
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
    if (!isSupportedArchivePath(filePath)) {
      setErrorKey('dropZone.unsupportedArchive')
      return
    }

    setArchivePath(filePath)
    runInspection(filePath)
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handlePreviewEntry = async (entry: ArchiveEntry, password = archivePassword) => {
    const api = (window as any).electronAPI
    if (!api?.previewArchiveEntry) return

    const previousRequestId = activePreviewRequest.current
    if (previousRequestId) void api.cancelArchivePreview(previousRequestId)
    const requestId = `archive-preview-${++previewRequestSequence.current}`
    activePreviewRequest.current = requestId
    setPreviewEntry(entry)
    setPreviewResult(null)
    setPreviewErrorKey(null)
    setPreviewLoading(true)
    // Stays true while the prompt is up so the panel behind it shows progress
    // rather than a blank body.
    let awaitingPassword = false

    try {
      const response = await api.previewArchiveEntry(archivePath, entry.id, requestId, password)
      if (activePreviewRequest.current !== requestId) return
      if (response.success) {
        setPreviewResult(response.result)
        if (password !== undefined) setArchivePassword(password)
      } else if (response.code === 'PASSWORD_REQUIRED' || response.code === 'WRONG_ZIP_PASSWORD') {
        // Only this entry is encrypted, so the listing behind the prompt stays
        // on screen and the preview resumes as soon as the password arrives.
        awaitingPassword = true
        setPasswordPrompt({
          target: 'entry',
          path: archivePath,
          entry,
          incorrect: response.code === 'WRONG_ZIP_PASSWORD'
        })
      } else {
        setPreviewErrorKey(`inspector.preview.errors.${response.errorCode || 'genericPreview'}`)
      }
    } catch {
      if (activePreviewRequest.current === requestId) {
        setPreviewErrorKey('inspector.preview.errors.genericPreview')
      }
    } finally {
      if (activePreviewRequest.current === requestId) {
        activePreviewRequest.current = null
        if (!awaitingPassword) setPreviewLoading(false)
      }
    }
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
  const splitVolumes = inspectData?.volumes && inspectData.volumes.length > 1
    ? inspectData.volumes
    : null

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
          <div className="archive-inspector__heading">
            <div className="archive-inspector__title-row">
              <h3 className="archive-inspector__title">
                {t('inspector.title')}
              </h3>
              {splitVolumes && (
                <button
                  type="button"
                  className="archive-inspector__split-badge"
                  aria-expanded={volumesExpanded}
                  aria-controls="archive-inspector-volumes"
                  aria-label={t(volumesExpanded ? 'inspector.hideVolumes' : 'inspector.showVolumes')}
                  onClick={() => setVolumesExpanded(expanded => !expanded)}
                >
                  <Files size={13} />
                  <span>{t('inspector.splitArchive')} · {t('inspector.volumeCount', { count: splitVolumes.length })}</span>
                  <ChevronDown className={volumesExpanded ? 'is-expanded' : ''} size={13} />
                </button>
              )}
            </div>
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
          {splitVolumes && volumesExpanded && (
            <section
              id="archive-inspector-volumes"
              className="glass-panel archive-inspector__volumes-panel"
              aria-label={t('inspector.volumes')}
            >
              <div className="archive-inspector__volumes-header">
                <div>
                  <h4 className="archive-inspector__volumes-title">{t('inspector.volumes')}</h4>
                  <p className="archive-inspector__volumes-description">
                    {t('inspector.splitDescription', { count: splitVolumes.length })}
                  </p>
                </div>
                <span className="archive-inspector__volumes-total">
                  {formatBytes(splitVolumes.reduce((total, volume) => total + volume.size, 0), language)}
                </span>
              </div>
              <div className="archive-inspector__volume-list">
                {splitVolumes.map(volume => (
                  <div key={volume.path} className="archive-inspector__volume">
                    <File className="archive-inspector__volume-icon" size={15} />
                    <div className="archive-inspector__volume-details">
                      <div className="archive-inspector__volume-name">{volume.name}</div>
                      <div className="archive-inspector__volume-path">{volume.path}</div>
                    </div>
                    <span className="archive-inspector__volume-size">{formatBytes(volume.size, language)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="archive-inspector__stats">
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.format')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--accent">{inspectData.format}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.totalFiles')}</div><div className="archive-inspector__stat-value">{t('inspector.fileCount', { count: inspectData.totalFiles })}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.extractedSize')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--size">{inspectData.totalUncompressedSize === null ? t('inspector.unknown') : formatBytes(inspectData.totalUncompressedSize, language)}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.efficiency')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--success">{inspectData.overallRatio === null ? t('inspector.unknown') : t('inspector.savings', { ratio: inspectData.overallRatio })}</div></div>
            {splitVolumes && <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.volumes')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--accent">{t('inspector.volumeCount', { count: splitVolumes.length })}</div></div>}
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
                <button
                  key={entry.id || entry.path}
                  type="button"
                  onClick={() => isNavigableDirectory
                    ? moveToPath(normalizeArchivePath(entry.path))
                    : handlePreviewEntry(entry)}
                  className={`archive-inspector__entry${isNavigableDirectory ? ' is-navigable' : ' is-previewable'}`}
                >
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
      {passwordPrompt && (
        <PasswordPromptModal
          archiveName={passwordPrompt.target === 'entry'
            ? passwordPrompt.entry.path
            : passwordPrompt.path.split(/[/\\]/).pop() || passwordPrompt.path}
          hasIncorrectPassword={passwordPrompt.incorrect}
          confirmLabel={t('passwordPrompt.open')}
          onConfirm={(password) => {
            const prompt = passwordPrompt
            setPasswordPrompt(null)
            if (prompt.target === 'listing') void runInspection(prompt.path, password)
            else void handlePreviewEntry(prompt.entry, password)
          }}
          onCancel={() => {
            if (passwordPrompt.target === 'entry') closePreview()
            setPasswordPrompt(null)
          }}
        />
      )}
      {previewEntry && (
        <ArchivePreviewModal
          entryPath={previewEntry.path}
          loading={previewLoading}
          result={previewResult}
          errorKey={previewErrorKey}
          onClose={closePreview}
        />
      )}
    </div>
  )
}
