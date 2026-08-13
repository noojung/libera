import React, { useEffect, useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import './PasswordPromptModal.css'

interface PasswordPromptModalProps {
  archiveName: string
  hasIncorrectPassword?: boolean
  onConfirm: (password: string) => void
  onCancel: () => void
}

export const PasswordPromptModal: React.FC<PasswordPromptModalProps> = ({ archiveName, hasIncorrectPassword, onConfirm, onCancel }) => {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')

  useEffect(() => {
    setPassword('')
  }, [archiveName])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (password) onConfirm(password)
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
      className="password-prompt"
    >
      <form onSubmit={submit} className="glass-panel password-prompt__dialog">
        <div className="password-prompt__header">
          <div className="password-prompt__icon">
            <LockKeyhole size={21} />
          </div>
          <div>
            <h2 className="password-prompt__title">{t('passwordPrompt.title')}</h2>
            <p className="password-prompt__archive-name">{archiveName}</p>
          </div>
        </div>
        <p className="password-prompt__description">{t('passwordPrompt.description')}</p>
        {hasIncorrectPassword && (
          <p role="alert" className="password-prompt__error">{t('passwordPrompt.incorrect')}</p>
        )}
        <input
          autoFocus
          type="password"
          className="input-text"
          placeholder={t('passwordPrompt.placeholder')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        <div className="password-prompt__actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>{t('passwordPrompt.cancel')}</button>
          <button type="submit" className="btn-primary password-prompt__submit" disabled={!password}>{t('passwordPrompt.extract')}</button>
        </div>
      </form>
    </div>
  )
}
