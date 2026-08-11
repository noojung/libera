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
          <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '20px', fontWeight: 700, color: '#362D27' }}>
            작업 대기열 목록 ({jobs.length}개) 📋
          </h3>
          <p style={{ fontSize: '13px', color: '#6E6158' }}>
            백그라운드에서 진행 중이거나 완료된 압축 및 해제 작업 상태입니다
          </p>
        </div>

        {jobs.some(j => j.status === 'completed' || j.status === 'error') && (
          <button className="btn-secondary" onClick={onClearCompleted}>
            완료된 작업 지우기
          </button>
        )}
      </div>

      {/* Jobs List */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {jobs.length === 0 ? (
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
            <span style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#A3968C' }}>
              진행 중이거나 완료된 작업이 없어요! 🐶
            </span>
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
                  ? '6px solid #52B788'
                  : job.status === 'error'
                    ? '6px solid #E76F51'
                    : '6px solid #FF8E72'
              }}
            >
              {/* Job Row Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {job.type === 'compress' ? (
                    <Archive size={20} color="#FF8E72" />
                  ) : (
                    <Download size={20} color="#5A9EED" />
                  )}
                  <div>
                    <h4 style={{ fontFamily: 'var(--font-cute)', fontSize: '17px', fontWeight: 700, color: '#362D27' }}>
                      {job.name}
                    </h4>
                    <span style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158' }}>
                      {job.type.toUpperCase()} • {job.format.toUpperCase()}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {job.status === 'running' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#FF8E72', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                      {job.percent}%
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#52B788', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <CheckCircle size={18} />
                      완료됨 ({job.durationMs}ms)
                    </div>
                  )}

                  {job.status === 'error' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#E76F51', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <AlertCircle size={18} />
                      실패
                    </div>
                  )}

                  {job.outputPath && (
                    <button
                      className="btn-secondary"
                      onClick={() => onOpenFolder(job.outputPath!)}
                      title="폴더 열기"
                    >
                      <FolderOpen size={15} />
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              {job.status === 'running' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{
                    height: '10px',
                    width: '100%',
                    background: '#FFF3E4',
                    border: '1.5px solid #4A403A',
                    borderRadius: '999px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${job.percent}%`,
                      background: 'var(--accent-gradient)',
                      transition: 'width 0.2s ease'
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                    <span>{job.currentFile || '처리 중...'}</span>
                    <span>{formatSize(job.processedBytes)} / {formatSize(job.totalBytes)}</span>
                  </div>
                </div>
              )}

              {/* Completed details */}
              {job.status === 'completed' && job.originalSize && job.compressedSize && (
                <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                  <span>원본: {formatSize(job.originalSize)}</span>
                  <span>압축 후: {formatSize(job.compressedSize)}</span>
                  <span style={{ color: '#52B788', fontWeight: 700, fontFamily: 'var(--font-cute)', fontSize: '14px' }}>
                    {Math.round((1 - (job.compressedSize / job.originalSize)) * 100)}% 절감!
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
