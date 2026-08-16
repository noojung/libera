import React, { useEffect, useMemo, useState } from 'react'
import { FileText, Image as ImageIcon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchivePreviewMediaType, ArchivePreviewResult } from '../../../services/archivePreview'
import { formatBytes } from '../i18n/format'
import type { AppLanguage } from '../i18n/language'
import './ArchivePreviewModal.css'

interface ArchivePreviewModalProps {
  entryPath: string
  loading: boolean
  result: ArchivePreviewResult | null
  errorKey: string | null
  onClose: () => void
}

function formatImageType(mediaType: ArchivePreviewMediaType): string {
  return mediaType.slice('image/'.length).toUpperCase()
}

export const ArchivePreviewModal: React.FC<ArchivePreviewModalProps> = ({
  entryPath,
  loading,
  result,
  errorKey,
  onClose
}) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const imageUrl = useMemo(() => {
    if (result?.kind !== 'image') return null
    const bytes = Uint8Array.from(result.data)
    return URL.createObjectURL(new Blob([bytes.buffer], { type: result.mediaType }))
  }, [result])

  useEffect(() => {
    if (!imageUrl) return
    return () => URL.revokeObjectURL(imageUrl)
  }, [imageUrl])

  const imageLoadFailed = imageUrl !== null && failedImageUrl === imageUrl

  const isImage = result?.kind === 'image'

  return (
    <div
      role="presentation"
      className="archive-preview"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-preview-title"
        className="glass-panel archive-preview__dialog"
      >
        <header className="archive-preview__header">
          <div className="archive-preview__heading">
            <div className={`archive-preview__icon${isImage ? ' archive-preview__icon--image' : ''}`}>
              {isImage ? <ImageIcon size={20} /> : <FileText size={20} />}
            </div>
            <div className="archive-preview__heading-text">
              <h2 id="archive-preview-title" className="archive-preview__title">{t('inspector.preview.title')}</h2>
              <p className="archive-preview__path">{entryPath}</p>
            </div>
          </div>
          <button
            autoFocus
            type="button"
            className="archive-preview__close"
            aria-label={t('inspector.preview.close')}
            title={t('inspector.preview.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className={`archive-preview__body${isImage ? ' archive-preview__body--image' : ''}`}>
          {loading ? (
            <div role="status" className="archive-preview__state">{t('inspector.preview.loading')}</div>
          ) : errorKey ? (
            <div role="alert" className="archive-preview__state archive-preview__state--error">
              {t(errorKey)}
            </div>
          ) : result?.kind === 'text' ? (
            result.text ? <pre className="archive-preview__content">{result.text}</pre> : (
              <div className="archive-preview__state">{t('inspector.preview.empty')}</div>
            )
          ) : result?.kind === 'image' ? (
            imageLoadFailed ? (
              <div role="alert" className="archive-preview__state archive-preview__state--error">
                {t('inspector.preview.errors.invalidImage')}
              </div>
            ) : imageUrl ? (
              <img
                className="archive-preview__image"
                src={imageUrl}
                alt={t('inspector.preview.imageAlt', { path: entryPath })}
                onError={() => setFailedImageUrl(imageUrl)}
              />
            ) : (
              <div role="status" className="archive-preview__state">{t('inspector.preview.loading')}</div>
            )
          ) : null}
        </div>

        {result?.kind === 'text' && (
          <footer className="archive-preview__footer">
            <span>{t('inspector.preview.encoding', { encoding: result.encoding.toUpperCase() })}</span>
            {result.truncated && (
              <span role="status" className="archive-preview__notice">
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
        {result?.kind === 'image' && (
          <footer className="archive-preview__footer">
            <span>{t('inspector.preview.imageFormat', { format: formatImageType(result.mediaType) })}</span>
            <span>{t('inspector.preview.imageDetails', {
              width: result.width,
              height: result.height,
              size: formatBytes(result.previewedBytes, language)
            })}</span>
          </footer>
        )}
      </section>
    </div>
  )
}
