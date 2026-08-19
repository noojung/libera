import React from 'react'
import { FolderOpen, CheckCircle, AlertCircle, Loader2, Archive, Download, Clock3, XCircle } from 'lucide-react'
import { ActiveJob } from '../types'
import { useTranslation } from 'react-i18next'
import { formatBytes, formatDuration } from '../i18n/format'
import { formatLabel } from '../utils/archivePaths'
import type { AppLanguage } from '../i18n/language'
import './QueueManager.css'

interface QueueManagerProps {
  jobs: ActiveJob[]
  onOpenFolder: (path: string) => void
  onClearCompleted: () => void
  onCancelJob: (jobId: string) => void
}

export const QueueManager: React.FC<QueueManagerProps> = ({ jobs, onOpenFolder, onClearCompleted, onCancelJob }) => {
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
    <div className="queue-manager">
      {/* Header */}
      <div className="glass-panel queue-manager__header">
        <div>
          <h3 className="queue-manager__title">
            {t('queue.title', { count: jobs.length })}
          </h3>
          <p className="queue-manager__subtitle">
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
      <div className="queue-manager__jobs">
        {jobs.length === 0 ? (
          <div className="glass-panel queue-manager__empty">
            <span>
              {t('queue.empty')}
            </span>
          </div>
        ) : (
          jobs.map((job) => (
            <div
              key={job.id}
              className={`glass-panel queue-manager__job queue-manager__job--${job.status}`}
            >
              {/* Job Row Header */}
              <div className="queue-manager__job-header">
                <div className="queue-manager__job-main">
                  {job.type === 'compress' ? (
                    <Archive className="queue-manager__job-icon queue-manager__job-icon--compress" size={20} />
                  ) : (
                    <Download className="queue-manager__job-icon queue-manager__job-icon--extract" size={20} />
                  )}
                  <div>
                    <h4 className="queue-manager__job-name">
                      {getJobName(job)}
                    </h4>
                    <span className="queue-manager__job-type">
                      {t(job.type === 'compress' ? 'queue.typeCompress' : 'queue.typeExtract')} • {formatLabel(job.format)}
                    </span>
                  </div>
                </div>

                <div className="queue-manager__job-actions">
                  {job.status === 'running' && (
                    <div className="queue-manager__status queue-manager__status--running">
                      <Loader2 className="queue-manager__spinner" size={18} />
                      {job.percent === null ? t('queue.processing') : `${job.percent}%`}
                    </div>
                  )}

                  {job.status === 'pending' && (
                    <div className="queue-manager__status queue-manager__status--pending">
                      <Clock3 size={18} />
                      {t('queue.pending')}
                    </div>
                  )}

                  {job.status === 'completed' && (
                    <div className="queue-manager__status queue-manager__status--completed">
                      <CheckCircle size={18} />
                      {t('queue.completed', { duration: formatDuration(job.durationMs, language) })}
                    </div>
                  )}

                  {job.status === 'error' && (
                    <div className="queue-manager__status queue-manager__status--error">
                      <AlertCircle size={18} />
                      {t('queue.failed')}
                    </div>
                  )}

                  {job.status === 'cancelled' && (
                    <div className="queue-manager__status queue-manager__status--cancelled">
                      <XCircle size={18} />
                      {t('queue.cancelled')}
                    </div>
                  )}

                  {(job.status === 'pending' || job.status === 'running') && (
                    <button
                      className="btn-secondary"
                      onClick={() => onCancelJob(job.id)}
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
                <div className="queue-manager__progress">
                  <div className="queue-manager__progress-track">
                    {job.percent === null ? (
                      <div className="queue-progress__bar queue-progress__bar--indeterminate" />
                    ) : (
                      <progress className="queue-manager__progress-value" max={100} value={job.percent} aria-label={`${job.percent}%`} />
                    )}
                  </div>
                  <div className="queue-manager__progress-details">
                    <span>{job.currentFile || t(`queue.phase.${job.phase}`)}</span>
                    <span>{job.totalBytes === null
                      ? t('queue.processed', { size: formatBytes(job.processedBytes, language) })
                      : `${formatBytes(job.processedBytes, language)} / ${formatBytes(job.totalBytes, language)}`}</span>
                  </div>
                </div>
              )}

              {job.status === 'error' && (
                <div role="alert" className="queue-manager__error">
                  {getJobError(job)}
                </div>
              )}

              {/* Completed details */}
              {job.status === 'completed' && job.originalSize && job.compressedSize && (
                <div className="queue-manager__completed-details">
                  <span>{t('queue.original', { size: formatBytes(job.originalSize, language) })}</span>
                  <span>{t('queue.compressed', { size: formatBytes(job.compressedSize, language) })}</span>
                  <span className="queue-manager__saved">
                    {t('queue.saved', { ratio: Math.round((1 - (job.compressedSize / job.originalSize)) * 100) })}
                  </span>
                  {job.volumeCount !== undefined && (
                    <span>{t('queue.volumes', { count: job.volumeCount })}</span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
