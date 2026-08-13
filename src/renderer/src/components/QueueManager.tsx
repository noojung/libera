import React from 'react'
import { FolderOpen, CheckCircle, AlertCircle, Loader2, Archive, Download, Clock3, XCircle } from 'lucide-react'
import { ActiveJob } from '../types'
import { useTranslation } from 'react-i18next'
import { formatBytes, formatDuration } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'

interface QueueManagerProps {
  jobs: ActiveJob[]
  onOpenFolder: (path: string) => void
  onClearCompleted: () => void
  onCancelExtraction: (jobId: string) => void
}

export const QueueManager: React.FC<QueueManagerProps> = ({ jobs, onOpenFolder, onClearCompleted, onCancelExtraction }) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'

  const getJobName = (job: ActiveJob) => {
    if (job.type === 'extract') return t('queue.extractName', { name: job.sourceName })
    if (job.itemCount > 1) return t('queue.compressItems', { count: job.itemCount })
    return t('queue.compressName', { name: job.sourceName })
  }

  const getJobError = (job: ActiveJob) => {
    const fallbackKey = job.type === 'compress' ? 'errors.genericCompression' : 'errors.genericExtraction'
    return t(job.errorCode ? `errors.${job.errorCode}` : fallbackKey)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Header */}
      <div className="glass-panel" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '20px', fontWeight: 700, color: '#362D27' }}>
            {t('queue.title', { count: jobs.length })}
          </h3>
          <p style={{ fontSize: '13px', color: '#6E6158' }}>
            {t('queue.subtitle')}
          </p>
        </div>

        {jobs.some(j => j.status === 'completed' || j.status === 'error' || j.status === 'cancelled') && (
          <button className="btn-secondary" onClick={onClearCompleted}>
            {t('queue.clearCompleted')}
          </button>
        )}
      </div>

      {/* Jobs List */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {jobs.length === 0 ? (
          <div className="glass-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
            <span style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', color: '#A3968C' }}>
              {t('queue.empty')}
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
                    : job.status === 'cancelled'
                      ? '6px solid #A3968C'
                      : job.status === 'pending'
                        ? '6px solid #5A9EED'
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
                      {getJobName(job)}
                    </h4>
                    <span style={{ fontFamily: 'var(--font-cute)', fontSize: '14px', color: '#6E6158' }}>
                      {t(job.type === 'compress' ? 'queue.typeCompress' : 'queue.typeExtract')} • {job.format.toUpperCase()}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {job.status === 'running' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#FF8E72', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
                      {job.percent === null ? t('queue.processing') : `${job.percent}%`}
                    </div>
                  )}

                  {job.status === 'pending' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#5A9EED', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <Clock3 size={18} />
                      {t('queue.pending')}
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#52B788', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <CheckCircle size={18} />
                      {t('queue.completed', { duration: formatDuration(job.durationMs, language) })}
                    </div>
                  )}

                  {job.status === 'error' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#E76F51', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <AlertCircle size={18} />
                      {t('queue.failed')}
                    </div>
                  )}

                  {job.status === 'cancelled' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#A3968C', fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700 }}>
                      <XCircle size={18} />
                      {t('queue.cancelled')}
                    </div>
                  )}

                  {job.type === 'extract' && (job.status === 'pending' || job.status === 'running') && (
                    <button
                      className="btn-secondary"
                      onClick={() => onCancelExtraction(job.id)}
                      title={t('queue.cancel')}
                      aria-label={t('queue.cancel')}
                    >
                      <XCircle size={15} />
                    </button>
                  )}

                  {job.outputPath && job.status === 'completed' && (
                    <button
                      className="btn-secondary"
                      onClick={() => onOpenFolder(job.outputPath!)}
                      title={t('queue.openFolder')}
                      aria-label={t('queue.openFolder')}
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
                    <div className={job.percent === null ? 'queue-progress__bar queue-progress__bar--indeterminate' : 'queue-progress__bar'} style={{
                      height: '100%',
                      width: job.percent === null ? '35%' : `${job.percent}%`,
                      background: 'var(--accent-gradient)',
                      transition: 'width 0.2s ease'
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                    <span>{job.currentFile || t(`queue.phase.${job.phase}`)}</span>
                    <span>{job.totalBytes === null
                      ? t('queue.processed', { size: formatBytes(job.processedBytes, language) })
                      : `${formatBytes(job.processedBytes, language)} / ${formatBytes(job.totalBytes, language)}`}</span>
                  </div>
                </div>
              )}

              {job.status === 'error' && (
                <div role="alert" style={{ fontSize: '12px', color: '#E76F51' }}>
                  {getJobError(job)}
                </div>
              )}

              {/* Completed details */}
              {job.status === 'completed' && job.originalSize && job.compressedSize && (
                <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
                  <span>{t('queue.original', { size: formatBytes(job.originalSize, language) })}</span>
                  <span>{t('queue.compressed', { size: formatBytes(job.compressedSize, language) })}</span>
                  <span style={{ color: '#52B788', fontWeight: 700, fontFamily: 'var(--font-cute)', fontSize: '14px' }}>
                    {t('queue.saved', { ratio: Math.round((1 - (job.compressedSize / job.originalSize)) * 100) })}
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
