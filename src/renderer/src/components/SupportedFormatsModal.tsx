import React, { useEffect } from 'react'
import { Check, FileArchive, Minus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_FORMATS } from '@/utils/archivePaths'
import './SupportedFormatsModal.css'

interface SupportedFormatsModalProps {
  onClose: () => void
}

/**
 * A tick or a dash, so a row reads the same way across every column. The mark
 * carries the answer for anyone who cannot see which one it is.
 */
const Ability: React.FC<{ able: boolean; label: string }> = ({ able, label }) => (
  <span role="img" aria-label={label} className={`supported-formats__ability${able ? ' is-able' : ''}`}>
    {able
      ? <Check size={14} strokeWidth={3} aria-hidden="true" />
      : <Minus size={12} strokeWidth={2} aria-hidden="true" />}
  </span>
)

/**
 * What each format can be asked to do.
 *
 * Every format here can be opened; the columns are what separates them, since
 * four of them are read only. A flat list would say "TAR.XZ is supported" and
 * leave someone looking for it in the compression format menu.
 */
export const SupportedFormatsModal: React.FC<SupportedFormatsModalProps> = ({ onClose }) => {
  const { t } = useTranslation()

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
      className="supported-formats"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="supported-formats-title"
        className="glass-panel supported-formats__dialog"
      >
        <header className="supported-formats__header">
          <div className="supported-formats__heading">
            <div className="supported-formats__icon">
              <FileArchive size={20} aria-hidden="true" />
            </div>
            <div>
              <h2 id="supported-formats-title" className="supported-formats__title">
                {t('supportedFormats.title')}
              </h2>
              <p className="supported-formats__description">{t('supportedFormats.description')}</p>
            </div>
          </div>
          <button
            autoFocus
            type="button"
            className="supported-formats__close"
            aria-label={t('supportedFormats.close')}
            title={t('supportedFormats.close')}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="supported-formats__body">
          <table className="supported-formats__table">
            <thead>
              <tr>
                <th scope="col">{t('supportedFormats.format')}</th>
                <th scope="col">{t('supportedFormats.compress')}</th>
                <th scope="col">{t('supportedFormats.extract')}</th>
                <th scope="col">{t('supportedFormats.read')}</th>
                <th scope="col">{t('supportedFormats.password')}</th>
                <th scope="col">{t('supportedFormats.split')}</th>
              </tr>
            </thead>
            <tbody>
              {SUPPORTED_FORMATS.map(format => (
                <tr key={format.name}>
                  <th scope="row">
                    <span className="supported-formats__name">{format.name}</span>
                    <span className="supported-formats__extensions">{format.extensions.join(' · ')}</span>
                  </th>
                  {(['compress', 'extract', 'read', 'password', 'split'] as const).map(ability => (
                    <td key={ability}>
                      <Ability
                        able={format[ability]}
                        label={t(format[ability] ? 'supportedFormats.yes' : 'supportedFormats.no')}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
