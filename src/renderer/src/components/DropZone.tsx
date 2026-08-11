import React, { useState } from 'react'
import { UploadCloud, File, Folder, X, FolderPlus, FilePlus } from 'lucide-react'
import { SelectedItem } from '../types'

interface DropZoneProps {
  items: SelectedItem[]
  onAddFiles: (paths: string[]) => void
  onRemoveItem: (index: number) => void
  onClearItems: () => void
  onSelectFilesDialog: (allowFolder?: boolean) => void
}

export const DropZone: React.FC<DropZoneProps> = ({
  items,
  onAddFiles,
  onRemoveItem,
  onClearItems,
  onSelectFilesDialog
}) => {
  const [isDragOver, setIsDragOver] = useState(false)

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
      const paths = droppedFiles.map((f: any) => f.path || f.name)
      onAddFiles(paths)
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
          border: isDragOver ? '2px dashed #0284C7' : '2px dashed #CBD5E1',
          background: isDragOver ? 'rgba(2, 132, 199, 0.05)' : '#FFFFFF',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          transition: 'all 0.2s ease',
          cursor: 'pointer',
          boxShadow: isDragOver ? '0 0 20px rgba(2, 132, 199, 0.15)' : '0 1px 3px rgba(0,0,0,0.04)'
        }}
        onClick={() => onSelectFilesDialog(false)}
      >
        <div style={{
          width: '54px',
          height: '54px',
          borderRadius: '16px',
          background: '#F1F5F9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '12px'
        }}>
          <UploadCloud size={28} color={isDragOver ? '#0284C7' : '#4F46E5'} />
        </div>

        <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#0F172A', marginBottom: '6px' }}>
          Drag & Drop files or folders here
        </h3>
        <p style={{ fontSize: '13px', color: '#64748B', marginBottom: '16px' }}>
          Supports multiple files, directories, or existing archives
        </p>

        <div style={{ display: 'flex', gap: '10px' }} onClick={(e) => e.stopPropagation()}>
          <button
            className="btn-secondary"
            onClick={() => onSelectFilesDialog(false)}
          >
            <FilePlus size={15} />
            Browse Files
          </button>
          <button
            className="btn-secondary"
            onClick={() => onSelectFilesDialog(true)}
          >
            <FolderPlus size={15} />
            Browse Folders
          </button>
        </div>
      </div>

      {/* Selected Items Preview List */}
      {items.length > 0 && (
        <div className="glass-panel" style={{ flex: 1, padding: '16px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>
              SELECTED ITEMS ({items.length})
            </span>
            <button
              onClick={onClearItems}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#DC2626',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Clear All
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
                  background: '#F8FAFC',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #E2E8F0'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                  {item.isDirectory ? (
                    <Folder size={18} color="#4F46E5" />
                  ) : (
                    <File size={18} color="#0284C7" />
                  )}
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: '13px', fontWeight: 500, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.name}
                    </div>
                    <div style={{ fontSize: '11px', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
                      {item.path}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '12px', color: '#475569', fontFamily: 'var(--font-mono)' }}>
                    {formatSize(item.size)}
                  </span>
                  <button
                    onClick={() => onRemoveItem(idx)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#94A3B8',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = '#DC2626')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = '#94A3B8')}
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
