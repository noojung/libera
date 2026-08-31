import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File, Files, Filter, Folder, Home, Microscope, Search, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchiveEntry, ArchiveInspectionResult } from '@services/archiveInspector'
import type { ArchivePreviewResult } from '@services/archivePreview'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { EXTRACT_DIALOG_EXTENSIONS, isSupportedArchivePath } from '@/utils/archivePaths'
import { useExpertMode } from '@/utils/expertMode'
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
  const prefix = currentPath ? `${currentPath}/` : ''
  const folderNames = new Set<string>()
  const files: ArchiveBrowserEntry[] = []

  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry.path)
    if (!normalized || normalized === currentPath) continue
    if (prefix && !normalized.startsWith(prefix)) continue

    const remainder = prefix ? normalized.slice(prefix.length) : normalized
    const segments = remainder.split('/')

    if (segments.length > 1) {
      folderNames.add(segments[0])
    } else if (entry.isDirectory) {
      folderNames.add(segments[0])
    } else {
      files.push({ ...entry, name: segments[0] })
    }
  }

  const folders: ArchiveBrowserEntry[] = Array.from(folderNames).map(folderName => ({
    id: `virtual-${folderName}`,
    name: folderName,
    path: prefix ? `${prefix}${folderName}` : folderName,
    isDirectory: true,
    size: 0,
    isVirtual: true
  }))

  folders.sort((a, b) => a.name.localeCompare(b.name, language, { sensitivity: 'base' }))
  files.sort((a, b) => a.name.localeCompare(b.name, language, { sensitivity: 'base' }))
  return [...folders, ...files]
}

export const ArchiveInspector: React.FC = () => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [isExpertMode] = useExpertMode()

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
  const [archivePassword, setArchivePassword] = useState<string | undefined>(undefined)
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
        setInspectData(null)
        setPasswordPrompt({
          target: 'listing',
          path: filePath,
          incorrect: response.code === 'WRONG_ZIP_PASSWORD'
        })
      } else {
        setInspectData(null)
        setErrorKey(response.errorCode ? `errors.${response.errorCode}` : 'inspector.readFailed')
      }
    } catch (error) {
      setInspectData(null)
      console.error('Archive inspection failed:', error)
      setErrorKey('inspector.inspectFailed')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenArchive = async () => {
    const api = (window as any).electronAPI
    if (!api) return
    const files = await api.selectFiles({
      allowDirectories: false,
      extensions: EXTRACT_DIALOG_EXTENSIONS,
      title: t('dialogs.selectExtractInputs'),
      filterName: t('dialogs.supportedArchives')
    })
    if (files.length > 0) {
      setArchivePath(files[0])
      void runInspection(files[0])
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    const file = files[0]
    let filePath = (file as File & { path?: string }).path || file.name
    if ((window as any).electronAPI?.getPathForFile) {
      try {
        filePath = (window as any).electronAPI.getPathForFile(file) || filePath
      } catch {
        // Fall back to the browser-provided path/name.
      }
    }
    if (!isSupportedArchivePath(filePath)) {
      setErrorKey('dropZone.unsupportedArchive')
      return
    }
    setArchivePath(filePath)
    void runInspection(filePath)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handlePreviewEntry = async (entry: ArchiveEntry, passwordOverride?: string) => {
    if (entry.isDirectory) return
    const api = (window as any).electronAPI
    if (!api?.previewArchiveEntry) return
    const previousRequestId = activePreviewRequest.current
    if (previousRequestId) void api.cancelArchivePreview(previousRequestId)
    const requestId = `archive-preview-${++previewRequestSequence.current}`
    activePreviewRequest.current = requestId
    const effectivePassword = passwordOverride ?? archivePassword
    setPreviewEntry(entry)
    setPreviewResult(null)
    setPreviewLoading(true)
    setPreviewErrorKey(null)

    let awaitingPassword = false
    try {
      const response = await api.previewArchiveEntry(
        archivePath,
        entry.id,
        requestId,
        isExpertMode ? { password: effectivePassword, includeRawBytes: true } : effectivePassword
      )
      if (activePreviewRequest.current !== requestId) return

      if (response?.success) {
        if (passwordOverride) setArchivePassword(passwordOverride)
        setPasswordPrompt(null)
        setPreviewResult(response.result)
        return
      }

      if (response?.code === 'PASSWORD_REQUIRED' || response?.code === 'WRONG_ZIP_PASSWORD') {
        awaitingPassword = true
        setPasswordPrompt({
          target: 'entry',
          path: archivePath,
          entry,
          incorrect: response.code === 'WRONG_ZIP_PASSWORD'
        })
        return
      }

      setPreviewErrorKey(`inspector.preview.errors.${response?.errorCode || 'genericPreview'}`)
    } catch {
      if (activePreviewRequest.current !== requestId) return
      setPreviewErrorKey('inspector.preview.errors.genericPreview')
    } finally {
      if (activePreviewRequest.current === requestId) {
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

          {/* Expert Technical Diagnostics Header Card */}
          {isExpertMode && inspectData.headerInfo && (
            <div className="expert-card archive-inspector__diagnostics">
              <div className="expert-card__header">
                <div className="expert-card__title">
                  <Microscope size={16} />
                  {t('inspector.expertHeader')}
                </div>
              </div>
              <div className="archive-inspector__diagnostics-grid">
                <div className="archive-inspector__diag-item">
                  <span className="archive-inspector__diag-label">{t('inspector.signature')}</span>
                  <span className="code-badge">{inspectData.headerInfo.signature || 'N/A'}</span>
                </div>
                <div className="archive-inspector__diag-item">
                  <span className="archive-inspector__diag-label">{t('inspector.codec')}</span>
                  <span className="archive-inspector__diag-value">{inspectData.headerInfo.codecSummary || 'N/A'}</span>
                </div>
                <div className="archive-inspector__diag-item">
                  <span className="archive-inspector__diag-label">{t('inspector.encryptionMethod')}</span>
                  <span className="archive-inspector__diag-value">{inspectData.headerInfo.encryptionAlgorithm || 'None'}</span>
                </div>
                <div className="archive-inspector__diag-item">
                  <span className="archive-inspector__diag-label">{t('inspector.solid')}</span>
                  <span className="archive-inspector__diag-value">{inspectData.headerInfo.solid ? t('inspector.solidYes') : t('inspector.solidNo')}</span>
                </div>
                {inspectData.headerInfo.formatVersion && (
                  <div className="archive-inspector__diag-item">
                    <span className="archive-inspector__diag-label">{t('inspector.headerVersion')}</span>
                    <span className="code-badge">{inspectData.headerInfo.formatVersion}</span>
                  </div>
                )}
                {inspectData.headerInfo.centralDirectoryOffset !== undefined && (
                  <div className="archive-inspector__diag-item">
                    <span className="archive-inspector__diag-label">{t('inspector.centralDirOffset')}</span>
                    <span className="code-badge">0x{inspectData.headerInfo.centralDirectoryOffset.toString(16).toUpperCase()}</span>
                  </div>
                )}
                {inspectData.headerInfo.centralDirectorySize !== undefined && (
                  <div className="archive-inspector__diag-item">
                    <span className="archive-inspector__diag-label">{t('inspector.centralDirSize')}</span>
                    <span className="archive-inspector__diag-value">{formatBytes(inspectData.headerInfo.centralDirectorySize, language)}</span>
                  </div>
                )}
                {inspectData.headerInfo.nextHeaderOffset !== undefined && (
                  <div className="archive-inspector__diag-item">
                    <span className="archive-inspector__diag-label">{t('inspector.nextHeaderOffset')}</span>
                    <span className="code-badge">0x{inspectData.headerInfo.nextHeaderOffset.toString(16).toUpperCase()}</span>
                  </div>
                )}
                {inspectData.headerInfo.nextHeaderSize !== undefined && (
                  <div className="archive-inspector__diag-item">
                    <span className="archive-inspector__diag-label">{t('inspector.nextHeaderSize')}</span>
                    <span className="archive-inspector__diag-value">{formatBytes(inspectData.headerInfo.nextHeaderSize, language)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="archive-inspector__stats">
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.format')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--accent">{inspectData.format}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.totalFiles')}</div><div className="archive-inspector__stat-value">{t('inspector.fileCount', { count: inspectData.totalFiles })}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.extractedSize')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--size">{inspectData.totalUncompressedSize === null ? t('inspector.unknown') : formatBytes(inspectData.totalUncompressedSize, language)}</div></div>
            <div className="glass-panel archive-inspector__stat"><div className="archive-inspector__stat-label">{t('inspector.compressedSize')}</div><div className="archive-inspector__stat-value archive-inspector__stat-value--size">{formatBytes(inspectData.totalCompressedSize, language)}</div></div>
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

            <div className={`archive-inspector__table-header${isExpertMode ? ' is-expert' : ''}`}>
              <div>{t(isSearching ? 'inspector.path' : 'inspector.fileName')}</div>
              <div className="archive-inspector__align-right">{t('inspector.originalSize')}</div>
              <div className="archive-inspector__align-right">{t('inspector.compressedSize')}</div>
              <div className="archive-inspector__align-right">{t('inspector.ratio')}</div>
              {isExpertMode && (
                <>
                  <div className="archive-inspector__align-center">{t('inspector.codec')}</div>
                  <div className="archive-inspector__align-center">{t('inspector.encryptionMethod')}</div>
                  <div className="archive-inspector__align-center">{t('inspector.crc32')}</div>
                  <div className="archive-inspector__align-center">{t('inspector.permissions')}</div>
                  <div className="archive-inspector__align-center">{t('inspector.offset')}</div>
                </>
              )}
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
                  className={`archive-inspector__entry${isNavigableDirectory ? ' is-navigable' : ' is-previewable'}${isExpertMode ? ' is-expert' : ''}`}
                >
                  <div className="archive-inspector__entry-main">
                    {entry.isDirectory ? <Folder className="archive-inspector__entry-icon archive-inspector__entry-icon--folder" size={16} /> : <File className="archive-inspector__entry-icon archive-inspector__entry-icon--file" size={16} />}
                    <span className="archive-inspector__entry-name">{isSearching ? formatRelativeArchivePath(entry.path, currentPath) : entry.name}</span>
                    {isNavigableDirectory && <ChevronRight className="archive-inspector__entry-chevron" size={15} />}
                  </div>
                  <div className="archive-inspector__entry-size">{entry.isDirectory ? '-' : entry.size === null ? t('inspector.unknown') : formatBytes(entry.size, language)}</div>
                  <div className="archive-inspector__entry-compressed-size">{entry.compressedSize !== undefined ? formatBytes(entry.compressedSize, language) : '-'}</div>
                  <div className={`archive-inspector__entry-ratio${entry.ratio !== null && entry.ratio !== undefined && entry.ratio > 0 ? ' is-positive' : ''}`}>{entry.ratio === null || entry.ratio === undefined ? '-' : `${entry.ratio}%`}</div>
                  {isExpertMode && (
                    <>
                      <div className="archive-inspector__align-center">
                        <span className="code-badge">{entry.codec || '-'}</span>
                      </div>
                      <div className="archive-inspector__align-center">
                        <span className="code-badge">{entry.encryptionMethod || '-'}</span>
                      </div>
                      <div className="archive-inspector__align-center archive-inspector__technical-value">
                        {entry.crc32 || '-'}
                      </div>
                      <div className="archive-inspector__align-center archive-inspector__technical-value archive-inspector__technical-value--muted">
                        {entry.modeString
                          ? `${entry.mode === undefined ? '' : `0${(entry.mode & 0o777).toString(8).padStart(3, '0')} / `}${entry.modeString}`
                          : '-'}
                      </div>
                      <div className="archive-inspector__align-center archive-inspector__technical-value archive-inspector__technical-value--muted">
                        {entry.offset === undefined ? '-' : `0x${entry.offset.toString(16).toUpperCase()}`}
                      </div>
                    </>
                  )}
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
          key={`${previewEntry.id || previewEntry.path}:${previewResult?.kind ?? 'pending'}`}
          entryPath={previewEntry.path}
          loading={previewLoading}
          result={previewResult}
          entry={previewEntry}
          errorKey={previewErrorKey}
          onClose={closePreview}
        />
      )}
    </div>
  )
}
