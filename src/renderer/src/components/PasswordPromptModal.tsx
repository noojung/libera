import React, { useEffect, useState } from 'react'
import { LockKeyhole } from 'lucide-react'

interface PasswordPromptModalProps {
  archiveName: string
  errorMessage?: string | null
  onConfirm: (password: string) => void
  onCancel: () => void
}

export const PasswordPromptModal: React.FC<PasswordPromptModalProps> = ({ archiveName, errorMessage, onConfirm, onCancel }) => {
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
      style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'rgba(54, 45, 39, 0.42)' }}
    >
      <form onSubmit={submit} className="glass-panel" style={{ width: 'min(440px, 100%)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '42px', height: '42px', borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#FFF3E4', border: '2px solid #4A403A' }}>
            <LockKeyhole size={21} color="#FF8E72" />
          </div>
          <div>
            <h2 style={{ fontFamily: 'var(--font-cute)', fontSize: '20px', color: '#362D27' }}>비밀번호가 필요한 ZIP 파일</h2>
            <p style={{ marginTop: '2px', color: '#6E6158', fontSize: '13px', overflowWrap: 'anywhere' }}>{archiveName}</p>
          </div>
        </div>
        <p style={{ color: '#6E6158', fontSize: '14px', lineHeight: 1.5 }}>이 ZIP 파일은 암호화되어 있습니다. 압축을 해제하려면 비밀번호를 입력해 주세요.</p>
        {errorMessage && (
          <p role="alert" style={{ marginTop: '-8px', color: '#E76F51', fontSize: '13px' }}>{errorMessage}</p>
        )}
        <input
          autoFocus
          type="password"
          className="input-text"
          placeholder="비밀번호 입력"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button type="button" className="btn-secondary" onClick={onCancel}>취소</button>
          <button type="submit" className="btn-primary" disabled={!password} style={{ opacity: password ? 1 : 0.5, cursor: password ? 'pointer' : 'not-allowed' }}>압축 해제</button>
        </div>
      </form>
    </div>
  )
}
