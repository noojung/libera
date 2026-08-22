import React, { useState } from 'react'
import { ChevronDown, UploadCloud, File, Files, Folder, X, FolderPlus, FilePlus } from 'lucide-react'
import { SelectedItem } from '@/types'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import './DropZone.css'

interface DropZoneProps {
  items: SelectedItem[]
  onAddFiles: (paths: string[]) => void
  onRemoveItem: (index: number) => void
  onClearItems: () => void
  onSelectFilesDialog: (allowFolder?: boolean) => void
  allowFolders?: boolean
  acceptedFileExtensions?: string[]
  acceptedFilePatterns?: RegExp[]
  validationError?: string | null
}

export const DropZone: React.FC<DropZoneProps> = ({
  items,
  onAddFiles,
  onRemoveItem,
  onClearItems,
  onSelectFilesDialog,
  allowFolders = true,
  acceptedFileExtensions,
  acceptedFilePatterns,
  validationError
}) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [isDragOver, setIsDragOver] = useState(false)
  const [hasUnsupportedDrop, setHasUnsupportedDrop] = useState(false)
  const [expandedVolumeItems, setExpandedVolumeItems] = useState<Set<SelectedItem>>(() => new Set())

  const toggleVolumes = (item: SelectedItem) => {
    setExpandedVolumeItems(current => {
      const next = new Set(current)
      if (next.has(item)) next.delete(item)
      else next.add(item)
      return next
    })
  }

  const removeItem = (item: SelectedItem, index: number) => {
    setExpandedVolumeItems(current => {
      if (!current.has(item)) return current
      const next = new Set(current)
      next.delete(item)
      return next
    })
    onRemoveItem(index)
  }

  const clearItems = () => {
    setExpandedVolumeItems(new Set())
    onClearItems()
  }

  const acceptsPath = (filePath: string) => {
    if (!acceptedFileExtensions && !acceptedFilePatterns) return true
    const normalizedPath = filePath.toLowerCase()
    if (acceptedFileExtensions?.some(extension => normalizedPath.endsWith(extension))) return true
    // Split volumes are numbered (.z01, .z02 ...) so they need a pattern
    // rather than a fixed suffix list.
    return acceptedFilePatterns?.some(pattern => pattern.test(normalizedPath)) ?? false
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length > 0) {
      const paths = droppedFiles.map((f: File) => {
        if ((window as any).electronAPI?.getPathForFile) {
          try {
            const p = (window as any).electronAPI.getPathForFile(f)
            if (p) return p
          } catch {
            // Falls through to the File API's own path below.
          }
        }
        return (f as any).path || f.name
      }).filter(Boolean)
      const acceptedPaths = paths.filter(acceptsPath)

      if (acceptedPaths.length !== paths.length) {
        setHasUnsupportedDrop(true)
      } else {
        setHasUnsupportedDrop(false)
      }

      if (acceptedPaths.length > 0) onAddFiles(acceptedPaths)
    }
  }

  return (
    <div className="drop-zone">
      {/* Drop Target Box */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`drop-zone__target${items.length > 0 ? ' drop-zone__target--compact' : ''}${isDragOver ? ' is-drag-over' : ''}`}
        onClick={() => onSelectFilesDialog(false)}
      >
        <div className="drop-zone__upload-icon">
          <UploadCloud className={isDragOver ? 'is-drag-over' : ''} size={28} />
        </div>

        <h3 className="drop-zone__title">
          {t(allowFolders ? 'dropZone.dropFilesAndFolders' : 'dropZone.dropArchives')}
        </h3>
        <p className="drop-zone__hint">
          {t(allowFolders ? 'dropZone.filesAndFoldersHint' : 'dropZone.archivesHint')}
        </p>

        {(hasUnsupportedDrop || validationError) && (
          <p role="alert" className="drop-zone__alert">
            {hasUnsupportedDrop ? t('dropZone.unsupportedArchive') : validationError}
          </p>
        )}

        <div className="drop-zone__actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn-secondary"
            onClick={() => onSelectFilesDialog(false)}
          >
            <FilePlus size={16} />
            {t('dropZone.browseFiles')}
          </button>
          {allowFolders && (
            <button
              className="btn-secondary"
              onClick={() => onSelectFilesDialog(true)}
            >
              <FolderPlus size={16} />
              {t('dropZone.browseFolders')}
            </button>
          )}
        </div>
      </div>

      {/* Selected Items Preview List */}
      {items.length > 0 && (
        <div className="glass-panel drop-zone__selection">
          <div className="drop-zone__selection-header">
            <span className="drop-zone__selection-title">
              {t('dropZone.selectedItems', { count: items.length })}
            </span>
            <button
              onClick={clearItems}
              className="drop-zone__clear-button"
            >
              {t('dropZone.clearAll')}
            </button>
          </div>

          <div className="drop-zone__items">
            {items.map((item, idx) => (
              <div
                key={item.path}
                className="drop-zone__item"
              >
                <div className="drop-zone__item-summary">
                  <div className="drop-zone__item-main">
                    {item.isDirectory ? (
                      <Folder className="drop-zone__item-icon drop-zone__item-icon--folder" size={18} />
                    ) : item.volumes ? (
                      <Files className="drop-zone__item-icon drop-zone__item-icon--file" size={18} />
                    ) : (
                      <File className="drop-zone__item-icon drop-zone__item-icon--file" size={18} />
                    )}
                    <div className="drop-zone__item-details">
                      <div className="drop-zone__item-name-row">
                        <div className="drop-zone__item-name">
                          {item.name}
                        </div>
                        {item.volumes && (
                          <button
                            type="button"
                            className="drop-zone__volume-badge"
                            aria-expanded={expandedVolumeItems.has(item)}
                            aria-controls={`drop-zone-volumes-${idx}`}
                            aria-label={t(expandedVolumeItems.has(item) ? 'dropZone.hideVolumes' : 'dropZone.showVolumes', { name: item.name })}
                            onClick={() => toggleVolumes(item)}
                          >
                            {t('dropZone.splitArchive')} · {t('dropZone.volumeCount', { count: item.volumes.length })}
                            <ChevronDown className={expandedVolumeItems.has(item) ? 'is-expanded' : ''} size={13} />
                          </button>
                        )}
                      </div>
                      <div className="drop-zone__item-path">
                        {item.path}
                      </div>
                    </div>
                  </div>

                  <div className="drop-zone__item-actions">
                    <span className="drop-zone__item-size">
                      {formatBytes(item.size, language)}
                    </span>
                    <button
                      onClick={() => removeItem(item, idx)}
                      aria-label={t('dropZone.removeItem', { name: item.name })}
                      className="drop-zone__remove-button"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>

                {item.volumes && expandedVolumeItems.has(item) && (
                  <div
                    id={`drop-zone-volumes-${idx}`}
                    role="region"
                    className="drop-zone__volumes"
                    aria-label={t('dropZone.volumeList', { name: item.name })}
                  >
                    {item.volumes.map(volume => (
                      <div key={volume.path} className="drop-zone__volume">
                        <File className="drop-zone__volume-icon" size={14} />
                        <div className="drop-zone__volume-details">
                          <div className="drop-zone__volume-name">{volume.name}</div>
                          <div className="drop-zone__volume-path">{volume.path}</div>
                        </div>
                        <span className="drop-zone__volume-size">
                          {formatBytes(volume.size, language)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
