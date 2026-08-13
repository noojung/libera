import React, { useEffect } from 'react'
import { FileText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchivePreviewResult } from '../../../services/archivePreview'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'
import './ArchiveTextPreviewModal.css'

interface ArchiveTextPreviewModalProps {
  entryPath: string
  loading: boolean
  result: ArchivePreviewResult | null
  errorKey: string | null
  onClose: () => void
}

export const ArchiveTextPreviewModal: React.FC<ArchiveTextPreviewModalProps> = ({
  entryPath,
  loading,
  result,
  errorKey,
  onClose
}) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      role="presentation"
      className="archive-text-preview"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-text-preview-title"
        className="glass-panel archive-text-preview__dialog"
      >
        <header className="archive-text-preview__header">
          <div className="archive-text-preview__heading">
            <div className="archive-text-preview__icon"><FileText size={20} /></div>
            <div className="archive-text-preview__heading-text">
              <h2 id="archive-text-preview-title" className="archive-text-preview__title">{t('inspector.preview.title')}</h2>
              <p className="archive-text-preview__path">{entryPath}</p>
            </div>
          </div>
          <button
            autoFocus
            type="button"
            className="archive-text-preview__close"
            aria-label={t('inspector.preview.close')}
            title={t('inspector.preview.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="archive-text-preview__body">
          {loading ? (
            <div role="status" className="archive-text-preview__state">{t('inspector.preview.loading')}</div>
          ) : errorKey ? (
            <div role="alert" className="archive-text-preview__state archive-text-preview__state--error">
              {t(errorKey)}
            </div>
          ) : result ? (
            result.text ? <pre className="archive-text-preview__content">{result.text}</pre> : (
              <div className="archive-text-preview__state">{t('inspector.preview.empty')}</div>
            )
          ) : null}
        </div>

        {result && (
          <footer className="archive-text-preview__footer">
            <span>{t('inspector.preview.encoding', { encoding: result.encoding.toUpperCase() })}</span>
            {result.truncated && (
              <span role="status" className="archive-text-preview__truncated">
                {result.totalBytes === null
                  ? t('inspector.preview.truncatedUnknown', { shown: formatBytes(result.previewedBytes, language) })
                  : t('inspector.preview.truncated', {
                      shown: formatBytes(result.previewedBytes, language),
                      total: formatBytes(result.totalBytes, language)
                    })}
              </span>
            )}
          </footer>
        )}
      </section>
    </div>
  )
}
