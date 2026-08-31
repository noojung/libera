import React, { useEffect, useMemo, useState } from 'react'
import { Copy, Check, FileText, Image as ImageIcon, X, Binary } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ArchivePreviewMediaType, ArchivePreviewResult } from '@services/archivePreview'
import type { ArchiveEntry } from '@services/archiveInspector'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { useExpertMode } from '@/utils/expertMode'
import { detectLineEnding, type LineEnding } from '@/utils/lineEndings'
import './ArchivePreviewModal.css'

interface ArchivePreviewModalProps {
  entryPath: string
  loading: boolean
  result: ArchivePreviewResult | null
  entry?: ArchiveEntry
  errorKey: string | null
  onClose: () => void
}

function formatLineEnding(ending: LineEnding, t: TFunction): string {
  if (ending === 'mixed') return t('inspector.preview.lineEndingMixed')
  if (ending === 'none') return t('inspector.preview.lineEndingNone')
  return ending.toUpperCase()
}

function formatImageType(mediaType: ArchivePreviewMediaType): string {
  return mediaType.slice('image/'.length).toUpperCase()
}

function initialViewMode(result: ArchivePreviewResult | null): 'text' | 'image' | 'hex' {
  if (result?.kind === 'image') return 'image'
  return 'text'
}

function formatHexDump(bytes: Uint8Array): string {
  const maxBytes = 1024 * 1024
  const slice = bytes.slice(0, maxBytes)
  const lines: string[] = []
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.slice(offset, offset + 16)
    const offsetHex = offset.toString(16).padStart(8, '0').toUpperCase()
    const hexParts: string[] = []
    let asciiPart = ''
    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        const b = chunk[i]
        hexParts.push(b.toString(16).padStart(2, '0').toUpperCase())
        asciiPart += b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'
      } else {
        hexParts.push('  ')
      }
    }
    const leftHex = hexParts.slice(0, 8).join(' ')
    const rightHex = hexParts.slice(8, 16).join(' ')
    lines.push(`${offsetHex}  ${leftHex}  ${rightHex}  |${asciiPart}|`)
  }
  return lines.join('\n')
}

export const ArchivePreviewModal: React.FC<ArchivePreviewModalProps> = ({
  entryPath,
  loading,
  result,
  entry,
  errorKey,
  onClose
}) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const [isExpertMode] = useExpertMode()

  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'text' | 'image' | 'hex'>(() => initialViewMode(result))
  const [copied, setCopied] = useState(false)

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

  const rawBytes = useMemo(() => {
    if (!result) return null
    if (result.kind === 'image') return Uint8Array.from(result.rawBytes ?? result.data)
    return Uint8Array.from(result.rawBytes ?? new TextEncoder().encode(result.text))
  }, [result])

  const displayedText = useMemo(() => {
    if (!result) return ''
    if (viewMode === 'hex') return rawBytes ? formatHexDump(rawBytes) : ''
    if (viewMode !== 'text' || result.kind !== 'text') return ''
    return result.text
  }, [result, viewMode, rawBytes])

  const lineEnding = useMemo(
    () => viewMode === 'text' ? detectLineEnding(displayedText) : null,
    [viewMode, displayedText]
  )

  const handleCopy = async () => {
    if (!displayedText) return
    try {
      await navigator.clipboard.writeText(displayedText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('Failed to copy text:', e)
    }
  }

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

          <div className="archive-preview__header-actions">
            {/* Images carry no expert controls: hex is reserved for text, and
                there is nothing else to switch a picture between. */}
            {isExpertMode && result?.kind === 'text' && rawBytes && (
              <div className="archive-preview__expert-controls">
                <div className="archive-preview__mode-toggle">
                  <button
                    type="button"
                    className={`archive-preview__toggle-btn${viewMode === 'text' ? ' is-active' : ''}`}
                    onClick={() => setViewMode('text')}
                  >
                    <FileText size={13} />
                    {t('inspector.preview.textView')}
                  </button>
                  <button
                    type="button"
                    className={`archive-preview__toggle-btn${viewMode === 'hex' ? ' is-active' : ''}`}
                    onClick={() => setViewMode('hex')}
                  >
                    <Binary size={13} />
                    {t('inspector.preview.hexView')}
                  </button>
                </div>

                <button
                  type="button"
                  className="btn-secondary archive-preview__copy-btn"
                  onClick={handleCopy}
                  title={t('inspector.preview.copyContent')}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copied ? t('inspector.preview.copied') : t('inspector.preview.copy')}</span>
                </button>
              </div>
            )}

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
          </div>
        </header>

        {isExpertMode && entry && (
          <div className="archive-preview__metadata">
            <span>{t('inspector.codec')}: {entry.codec || '-'}</span>
            <span>{t('inspector.encryptionMethod')}: {entry.encryptionMethod || '-'}</span>
            <span>{t('inspector.crc32')}: {entry.crc32 || '-'}</span>
            <span>{t('inspector.originalSize')}: {entry.size === null ? '-' : formatBytes(entry.size, language)}</span>
            <span>{t('inspector.compressedSize')}: {entry.compressedSize === undefined ? '-' : formatBytes(entry.compressedSize, language)}</span>
          </div>
        )}

        <div className={`archive-preview__body${isImage && viewMode === 'image' ? ' archive-preview__body--image' : ''}`}>
          {loading ? (
            <div role="status" className="archive-preview__state">{t('inspector.preview.loading')}</div>
          ) : errorKey ? (
            <div role="alert" className="archive-preview__state archive-preview__state--error">
              {t(errorKey)}
            </div>
          ) : viewMode === 'hex' && result ? (
            displayedText ? <pre className="archive-preview__content archive-preview__content--hex">{displayedText}</pre> : (
              <div className="archive-preview__state">{t('inspector.preview.empty')}</div>
            )
          ) : viewMode === 'text' && result?.kind === 'text' ? (
            displayedText ? (
              <pre className="archive-preview__content">{displayedText}</pre>
            ) : (
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
            {/* Grouped, because the footer spaces its children apart and the
                line endings belong with the encoding, not across from it. */}
            <div className="archive-preview__meta">
              <span>
                {viewMode === 'hex'
                  ? t('inspector.preview.hexView')
                  : t('inspector.preview.encoding', { encoding: result.encoding.toUpperCase() })}
              </span>
              {lineEnding && (
                <span>{t('inspector.preview.lineEnding', { ending: formatLineEnding(lineEnding, t) })}</span>
              )}
            </div>
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
