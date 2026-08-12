import React, { useState } from 'react'
import { UploadCloud, File, Folder, X, FolderPlus, FilePlus } from 'lucide-react'
import { SelectedItem } from '../types'

interface DropZoneProps {
  items: SelectedItem[]
  onAddFiles: (paths: string[]) => void
  onRemoveItem: (index: number) => void
  onClearItems: () => void
  onSelectFilesDialog: (allowFolder?: boolean) => void
  allowFolders?: boolean
  acceptedFileExtensions?: string[]
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
  validationError
}) => {
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  const acceptsPath = (filePath: string) => {
    if (!acceptedFileExtensions) return true
    const normalizedPath = filePath.toLowerCase()
    return acceptedFileExtensions.some(extension => normalizedPath.endsWith(extension))
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
            // fallback
          }
        }
        return (f as any).path || f.name
      }).filter(Boolean)
      const acceptedPaths = paths.filter(acceptsPath)

      if (acceptedPaths.length !== paths.length) {
        setDropError('ZIP, TAR, TAR.GZ, TGZ, GZ 압축 파일만 추가할 수 있습니다.')
      } else {
        setDropError(null)
      }

      if (acceptedPaths.length > 0) onAddFiles(acceptedPaths)
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '16px' }}>
      {/* Drop Target Box */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          flex: items.length > 0 ? '0 0 160px' : 1,
          border: isDragOver ? '2.5px dashed #FF8E72' : '2px dashed #4A403A',
          background: isDragOver ? '#FFF4E8' : '#FFFFFF',
          borderRadius: '20px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          transition: 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
          cursor: 'pointer',
          boxShadow: isDragOver ? '4px 6px 0px #4A403A' : '3px 3px 0px #4A403A',
          transform: isDragOver ? 'scale(1.01)' : 'none'
        }}
        onClick={() => onSelectFilesDialog(false)}
      >
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: '#FFF3E4',
          border: '2px solid #4A403A',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '10px',
          boxShadow: '2px 2px 0px #4A403A'
        }}>
          <UploadCloud size={28} color={isDragOver ? '#FF8E72' : '#362D27'} />
        </div>

        <h3 style={{
          fontFamily: 'var(--font-cute)',
          fontSize: '20px',
          fontWeight: 700,
          color: '#362D27',
          marginBottom: '4px'
        }}>
          {allowFolders ? '파일이나 폴더를 여기에 놓아주세요! 🐾' : '압축 파일을 여기에 놓아주세요! 🐾'}
        </h3>
        <p style={{
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          color: '#6E6158',
          marginBottom: '16px'
        }}>
          {allowFolders ? '여러 파일, 폴더 또는 압축 해제할 파일 선택 가능' : 'ZIP, TAR, TAR.GZ, TGZ, GZ 파일만 선택 가능'}
        </p>

        {(dropError || validationError) && (
          <p role="alert" style={{ marginTop: '-8px', marginBottom: '12px', color: '#E76F51', fontSize: '13px' }}>
            {dropError || validationError}
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px' }} onClick={(e) => e.stopPropagation()}>
          <button
            className="btn-secondary"
            onClick={() => onSelectFilesDialog(false)}
          >
            <FilePlus size={16} />
            파일 찾아보기
          </button>
          {allowFolders && (
            <button
              className="btn-secondary"
              onClick={() => onSelectFilesDialog(true)}
            >
              <FolderPlus size={16} />
              폴더 찾아보기
            </button>
          )}
        </div>
      </div>

      {/* Selected Items Preview List */}
      {items.length > 0 && (
        <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontFamily: 'var(--font-cute)', fontSize: '16px', fontWeight: 700, color: '#362D27' }}>
              선택한 항목 ({items.length}개)
            </span>
            <button
              onClick={onClearItems}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#E76F51',
                fontFamily: 'var(--font-cute)',
                fontSize: '15px',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              전체 비우기
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#FAF7F2',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  border: '1.5px solid #4A403A'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                  {item.isDirectory ? (
                    <Folder size={18} color="#FF8E72" />
                  ) : (
                    <File size={18} color="#5A9EED" />
                  )}
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#362D27', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: '11px', color: '#A3968C', fontFamily: 'var(--font-mono)' }}>
                      {item.path}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                    {formatSize(item.size)}
                  </span>
                  <button
                    onClick={() => onRemoveItem(idx)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#A3968C',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#E76F51')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#A3968C')}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
