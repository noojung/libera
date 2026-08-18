import React, { useEffect } from 'react'
import { ChevronRight, ExternalLink, Github, PackageOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import appInfo from '../generated/appInfo.json'
import logoImg from '../assets/logo.png'
import './AboutModal.css'

interface AboutModalProps {
  onClose: () => void
  onShowLicenses: () => void
}

function openExternalLink(url: string): void {
  void (window as any).electronAPI?.openExternalLink(url)
}

export const AboutModal: React.FC<AboutModalProps> = ({ onClose, onShowLicenses }) => {
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
      className="about-modal"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-modal-title"
        className="glass-panel about-modal__dialog"
      >
        <button
          autoFocus
          type="button"
          className="about-modal__close"
          aria-label={t('about.close')}
          title={t('about.close')}
          onClick={onClose}
        >
          <X size={18} />
        </button>

        <div className="about-modal__identity">
          <img className="about-modal__logo" src={logoImg} alt="" />
          <h2 id="about-modal-title" className="about-modal__title">Libera</h2>
          <p className="about-modal__version">{t('about.version', { version: appInfo.version })}</p>
          <p className="about-modal__tagline">{t('about.tagline')}</p>
        </div>

        <div className="about-modal__links">
          <button type="button" className="about-modal__link" onClick={() => openExternalLink(appInfo.homepage)}>
            <ExternalLink size={14} />
            {t('about.website')}
          </button>
          <button type="button" className="about-modal__link" onClick={() => openExternalLink(appInfo.repositoryUrl)}>
            <Github size={14} />
            {t('about.viewSource')}
          </button>
        </div>

        {/* The licenses list lives one level down: this button is what makes
            the info icon mean "about" rather than jumping straight to a wall
            of license text. */}
        <button type="button" className="about-modal__licenses" onClick={onShowLicenses}>
          <span className="about-modal__licenses-icon">
            <PackageOpen size={18} />
          </span>
          <span className="about-modal__licenses-text">
            <span className="about-modal__licenses-title">{t('about.openSourceLicenses')}</span>
            <span className="about-modal__licenses-hint">{t('about.openSourceLicensesHint')}</span>
          </span>
          <ChevronRight size={16} className="about-modal__licenses-chevron" />
        </button>

        <p className="about-modal__copyright">
          {t('about.copyright', { year: appInfo.copyrightYear, holder: appInfo.copyrightHolder })}
        </p>
      </section>
    </div>
  )
}
