import React, { useEffect } from 'react'
import { ChevronRight, createLucideIcon, ExternalLink, FileArchive, PackageOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import appInfo from '@/generated/appInfo.json'
import logoImg from '@/assets/logo.png'
import './AboutModal.css'

// Lucide 1.0 dropped its brand icons; this is the GitHub mark it shipped
// before, so the source link keeps its look.
const Github = createLucideIcon('Github', [
  ['path', { d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4', key: 'tonef' }],
  ['path', { d: 'M9 18c-4.51 2-5-2-7-2', key: '9comsn' }]
])

interface AboutModalProps {
  onClose: () => void
  onShowLicenses: () => void
  onShowSupportedFormats: () => void
}

function openExternalLink(url: string): void {
  void (window as any).electronAPI?.openExternalLink(url)
}

export const AboutModal: React.FC<AboutModalProps> = ({ onClose, onShowLicenses, onShowSupportedFormats }) => {
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

        <button type="button" className="about-modal__section" onClick={onShowSupportedFormats}>
          <span className="about-modal__section-icon">
            <FileArchive size={18} />
          </span>
          <span className="about-modal__section-text">
            <span className="about-modal__section-title">{t('supportedFormats.title')}</span>
            <span className="about-modal__section-hint">{t('about.supportedFormatsHint')}</span>
          </span>
          <ChevronRight size={16} className="about-modal__section-chevron" />
        </button>

        <button type="button" className="about-modal__section" onClick={onShowLicenses}>
          <span className="about-modal__section-icon">
            <PackageOpen size={18} />
          </span>
          <span className="about-modal__section-text">
            <span className="about-modal__section-title">{t('about.openSourceLicenses')}</span>
            <span className="about-modal__section-hint">{t('about.openSourceLicensesHint')}</span>
          </span>
          <ChevronRight size={16} className="about-modal__section-chevron" />
        </button>

        <p className="about-modal__copyright">
          {t('about.copyright', { year: appInfo.copyrightYear, holder: appInfo.copyrightHolder })}
        </p>
      </section>
    </div>
  )
}
