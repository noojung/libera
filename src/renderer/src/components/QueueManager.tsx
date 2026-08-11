import React from 'react'
import { FolderOpen, CheckCircle, AlertCircle, Loader2, Archive, Download } from 'lucide-react'
import { ActiveJob } from '../types'

interface QueueManagerProps {
  jobs: ActiveJob[]
  onOpenFolder: (path: string) => void
  onClearCompleted: () => void
}

export const QueueManager: React.FC<QueueManagerProps> = ({ jobs, onOpenFolder, onClearCompleted }) => {
  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Header */}
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#F8FAFC' }}>
            Job Operations Queue ({jobs.length})
          </h3>
          <p style={{ fontSize: '12px', color: '#94A3B8' }}>
            Real-time status of background compression and extraction tasks
          </p>
        </div>

        {jobs.some(j => j.status === 'completed' || j.status === 'error') && (
          <button className="btn-secondary" onClick={onClearCompleted}>
            Clear Completed
          </button>
        )}
      </div>

      {/* Jobs List */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {jobs.length === 0 ? (
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
            <span style={{ fontSize: '14px', color: '#64748B' }}>No active or completed jobs in queue</span>
          </div>
        ) : (
          jobs.map((job) => (
            <div
              key={job.id}
              className="glass-panel"
              style={{
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                borderLeft: job.status === 'completed'
                  ? '4px solid #10B981'
                  : job.status === 'error'
                    ? '4px solid #EF4444'
                    : '4px solid #38BDF8'
              }}
            >
              {/* Job Row Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {job.type === 'compress' ? (
                    <Archive size={20} color="#38BDF8" />
                  ) : (
                    <Download size={20} color="#818CF8" />
                  )}
                  <div>
                    <h4 style={{ fontSize: '14px', fontWeight: 600, color: '#F8FAFC' }}>
                      {job.name}
                    </h4>
                    <span style={{ fontSize: '11px', color: '#94A3B8' }}>
                      {job.type.toUpperCase()} • {job.format.toUpperCase()}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {job.status === 'running' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#38BDF8', fontSize: '12px', fontWeight: 600 }}>
                      <Loader2 size={16} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
                      {job.percent}%
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#10B981', fontSize: '12px', fontWeight: 600 }}>
                      <CheckCircle size={16} />
                      Completed ({job.durationMs}ms)
                    </div>
                  )}

                  {job.status === 'error' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#EF4444', fontSize: '12px', fontWeight: 600 }}>
                      <AlertCircle size={16} />
                      Failed
                    </div>
                  )}

                  {job.outputPath && (
                    <button
                      className="btn-secondary"
                      onClick={() => onOpenFolder(job.outputPath!)}
                      title="Reveal in File Explorer"
                    >
                      <FolderOpen size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              {job.status === 'running' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{
                    height: '6px',
                    width: '100%',
                    background: 'rgba(255, 255, 255, 0.1)',
                    borderRadius: '999px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${job.percent}%`,
                      background: 'linear-gradient(90deg, #06B6D4, #6366F1)',
                      transition: 'width 0.2s ease'
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
                    <span>{job.currentFile || 'Processing...'}</span>
                    <span>{formatSize(job.processedBytes)} / {formatSize(job.totalBytes)}</span>
                  </div>
                </div>
              )}

              {/* Completed details */}
              {job.status === 'completed' && job.originalSize && job.compressedSize && (
                <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#94A3B8', fontFamily: 'var(--font-mono)' }}>
                  <span>Original: {formatSize(job.originalSize)}</span>
                  <span>Compressed: {formatSize(job.compressedSize)}</span>
                  <span style={{ color: '#10B981', fontWeight: 600 }}>
                    Saved: {Math.round((1 - (job.compressedSize / job.originalSize)) * 100)}%
                  </span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
