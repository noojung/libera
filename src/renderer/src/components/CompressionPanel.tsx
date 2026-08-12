import React, { useState, useEffect } from 'react'
import { Sliders, Archive } from 'lucide-react'
import { SelectedItem } from '../types'

interface CompressionPanelProps {
  items: SelectedItem[]
  onStartCompress: (options: {
    format: 'zip' | 'tar' | 'gz' | 'tgz'
    level: number
    outputPath: string
    password?: string
  }) => void
}

export const CompressionPanel: React.FC<CompressionPanelProps> = ({ items, onStartCompress }) => {
  const [format, setFormat] = useState<'zip' | 'tar' | 'gz' | 'tgz'>('zip')
  const [level, setLevel] = useState<number>(6)
  const [customName] = useState<string>('archive')
  const [outputPath, setOutputPath] = useState<string>('')
  const [defaultDir, setDefaultDir] = useState<string>('')
  const [password, setPassword] = useState<string>('')
  const [passwordConfirmation, setPasswordConfirmation] = useState<string>('')

  useEffect(() => {
    if ((window as any).electronAPI?.getDefaultOutputDir) {
      (window as any).electronAPI.getDefaultOutputDir().then((dir: string) => {
        if (dir) setDefaultDir(dir)
      })
    }
  }, [])

  const handleSelectSavePath = async () => {
    if ((window as any).electronAPI) {
      const defaultName = `${customName}.${format}`
      const chosenPath = await (window as any).electronAPI.selectSaveLocation(defaultName, format)
      if (chosenPath) {
        setOutputPath(chosenPath)
      }
    }
  }

  const getLevelLabel = (lvl: number) => {
    if (lvl === 0) return '0 - 압축 없음 (가장 빠름)'
    if (lvl <= 3) return `${lvl} - 빠른 압축`
    if (lvl <= 6) return `${lvl} - 균형 표준`
    return `${lvl} - 최대 압축`
  }

  const handleCompress = () => {
    if (format === 'zip' && password !== passwordConfirmation) {
      return
    }
    const sep = defaultDir.includes('\\') ? '\\' : '/'
    const fallbackPath = defaultDir ? `${defaultDir}${sep}${customName}.${format}` : `${customName}.${format}`
    const finalOutput = outputPath || fallbackPath
    onStartCompress({
      format,
      level,
      outputPath: finalOutput,
      password: format === 'zip' ? password || undefined : undefined
    })
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div className="glass-panel" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontFamily: 'var(--font-cute)', fontSize: '18px', fontWeight: 700, color: '#362D27', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Sliders size={18} color="#FF8E72" />
          압축 옵션 설정 ⚙️
        </h3>
        <span style={{ fontSize: '12px', color: '#6E6158', fontFamily: 'var(--font-mono)' }}>
          총 용량: {formatSize(totalBytes)}
        </span>
      </div>

      {/* Target Format Selector */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '8px', display: 'block' }}>
          압축 포맷 선택
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
          {(['zip', 'tar', 'gz', 'tgz'] as const).map((fmt) => (
            <button
              key={fmt}
              onClick={() => setFormat(fmt)}
              style={{
                background: format === fmt ? '#FFF3E4' : '#FFFFFF',
                border: format === fmt ? '2px solid #FF8E72' : '1.5px solid #4A403A',
                color: format === fmt ? '#FF8E72' : '#362D27',
                padding: '10px',
                borderRadius: '12px',
                fontFamily: 'var(--font-cute)',
                fontSize: '16px',
                fontWeight: 700,
                cursor: 'pointer',
                textAlign: 'center',
                boxShadow: format === fmt ? '2px 2px 0px #4A403A' : 'none',
                transition: 'all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)'
              }}
            >
              .{fmt.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Compression Level Slider */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
          <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27' }}>
            압축 강도 레벨
          </label>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600, color: '#FF8E72' }}>
            {getLevelLabel(level)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="9"
          value={level}
          onChange={(e) => setLevel(parseInt(e.target.value))}
          style={{
            width: '100%',
            accentColor: '#FF8E72',
            cursor: 'pointer'
          }}
        />
      </div>

      {format === 'zip' && (
        <div>
          <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
            ZIP 비밀번호 <span style={{ fontFamily: 'var(--font-sans)', fontSize: '12px', color: '#6E6158', fontWeight: 400 }}>(선택)</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <input type="password" className="input-text" placeholder="비밀번호 입력" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <input type="password" className="input-text" placeholder="비밀번호 확인" value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} autoComplete="new-password" />
          </div>
          {password && password !== passwordConfirmation && (
            <p style={{ fontSize: '12px', color: '#E76F51', marginTop: '6px' }}>비밀번호가 일치하지 않습니다.</p>
          )}
          {password && password === passwordConfirmation && (
            <p style={{ fontSize: '12px', color: '#6E6158', marginTop: '6px' }}>ZIP 호환용 암호화가 적용됩니다. 강한 기밀 보호 용도로는 권장하지 않습니다.</p>
          )}
        </div>
      )}

      {/* Save Destination */}
      <div>
        <label style={{ fontFamily: 'var(--font-cute)', fontSize: '15px', fontWeight: 700, color: '#362D27', marginBottom: '6px', display: 'block' }}>
          저장 위치 선택
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input-text"
            placeholder={`저장 경로 지정을 위해 찾아보기를 눌러주세요`}
            value={outputPath}
            onChange={(e) => setOutputPath(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSelectSavePath} style={{ whiteSpace: 'nowrap' }}>
            찾아보기
          </button>
        </div>
      </div>

      {/* Start Button */}
      <button
        className="btn-primary"
        onClick={handleCompress}
        disabled={items.length === 0 || (format === 'zip' && password !== passwordConfirmation)}
        style={{
          width: '100%',
          justifyContent: 'center',
          padding: '12px',
          opacity: (items.length === 0 || (format === 'zip' && password !== passwordConfirmation)) ? 0.5 : 1,
          cursor: (items.length === 0 || (format === 'zip' && password !== passwordConfirmation)) ? 'not-allowed' : 'pointer'
        }}
      >
        <Archive size={20} />
        압축 시작하기 🚀
      </button>
    </div>
  )
}
