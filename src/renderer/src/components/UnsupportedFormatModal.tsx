import React, { useEffect, useState } from 'react'
import { FileWarning } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SupportedFormatsModal } from './SupportedFormatsModal'
import './UnsupportedFormatModal.css'

export const UnsupportedFormatModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation()
  const [showFormats, setShowFormats] = useState(false)

  useEffect(() => {
    if (showFormats) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, showFormats])

  if (showFormats) return <SupportedFormatsModal onClose={() => setShowFormats(false)} />

  return (
    <div
      className="unsupported-format"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsupported-format-title"
        aria-describedby="unsupported-format-description"
        className="glass-panel unsupported-format__dialog"
      >
        <div className="unsupported-format__heading">
          <FileWarning size={24} className="unsupported-format__icon" aria-hidden="true" />
          <h2 id="unsupported-format-title">{t('errors.unsupportedArchive')}</h2>
        </div>
        <p id="unsupported-format-description">{t('unsupportedFormat.description')}</p>
        <div className="unsupported-format__actions">
          <button type="button" className="btn-secondary" onClick={() => setShowFormats(true)}>
            {t('unsupportedFormat.viewFormats')}
          </button>
          <button autoFocus type="button" className="btn-primary" onClick={onClose}>
            {t('unsupportedFormat.confirm')}
          </button>
        </div>
      </section>
    </div>
  )
}
