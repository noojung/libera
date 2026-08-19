import React, { useEffect, useState } from 'react'
import { PackageOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import thirdPartyLicenses from '@/generated/thirdPartyLicenses.json'
import './LicensesModal.css'

interface LicensesModalProps {
  onClose: () => void
}

export const LicensesModal: React.FC<LicensesModalProps> = ({ onClose }) => {
  const { t } = useTranslation()
  const [selectedName, setSelectedName] = useState(thirdPartyLicenses[0]?.name ?? '')
  const selected = thirdPartyLicenses.find(entry => entry.name === selectedName)

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
      className="licenses-modal"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="licenses-modal-title"
        className="glass-panel licenses-modal__dialog"
      >
        <header className="licenses-modal__header">
          <div className="licenses-modal__heading">
            <div className="licenses-modal__icon">
              <PackageOpen size={20} />
            </div>
            <div>
              <h2 id="licenses-modal-title" className="licenses-modal__title">{t('licenses.title')}</h2>
              <p className="licenses-modal__description">{t('licenses.description')}</p>
            </div>
          </div>
          <button
            autoFocus
            type="button"
            className="licenses-modal__close"
            aria-label={t('licenses.close')}
            title={t('licenses.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="licenses-modal__body">
          <nav className="licenses-modal__list" aria-label={t('licenses.title')}>
            {thirdPartyLicenses.map(entry => (
              <button
                key={entry.name}
                type="button"
                className={`licenses-modal__package${entry.name === selectedName ? ' is-active' : ''}`}
                aria-current={entry.name === selectedName ? 'true' : undefined}
                aria-label={`${entry.name}, ${entry.version}, ${entry.license}`}
                onClick={() => setSelectedName(entry.name)}
              >
                <span className="licenses-modal__package-name">{entry.name}</span>
                <span className="licenses-modal__package-meta">{entry.version} · {entry.license}</span>
              </button>
            ))}
          </nav>
          <div className="licenses-modal__text-panel">
            {selected ? (
              <pre className="licenses-modal__text">{selected.text}</pre>
            ) : (
              <div className="licenses-modal__empty">{t('licenses.selectPackage')}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
