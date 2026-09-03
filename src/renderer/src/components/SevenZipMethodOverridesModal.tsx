import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, File, Files, Folder, Home, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchiveInputTreeEntry } from '@services/archiveInputTree'
import type {
  SevenZipCompressionLevel,
  SevenZipMethodOverride,
  SevenZipOverrideMethod
} from '@services/compressor'
import type { SelectedItem } from '@/types'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { Select, type SelectOption } from './Select'
import './ZipMethodOverridesModal.css'

type MethodSelection = SevenZipOverrideMethod | 'mixed'
type LevelSelection = SevenZipCompressionLevel | 'mixed'

const SEVEN_ZIP_LEVELS: readonly SevenZipCompressionLevel[] = [1, 3, 5, 7, 9]

interface SevenZipMethodOverridesModalProps {
  items: SelectedItem[]
  overrides: SevenZipMethodOverride[]
  defaultLevel: number
  onChange: (overrides: SevenZipMethodOverride[]) => void
  onClose: () => void
}

interface ChildState {
  status: 'loading' | 'loaded' | 'error'
  entries: ArchiveInputTreeEntry[]
}

function comparablePath(value: string, isWindows: boolean): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindows ? normalized.toLowerCase() : normalized
}

function isDescendant(parentPath: string, candidatePath: string, isWindows: boolean): boolean {
  const parent = comparablePath(parentPath, isWindows)
  const candidate = comparablePath(candidatePath, isWindows)
  return candidate.startsWith(`${parent}/`)
}

export const SevenZipMethodOverridesModal: React.FC<SevenZipMethodOverridesModalProps> = ({
  items,
  overrides,
  defaultLevel,
  onChange,
  onClose
}) => {
  const { t, i18n } = useTranslation()
  const language: AppLanguage = i18n.resolvedLanguage === 'ko' ? 'ko' : 'en'
  const platform = (window as any).electronAPI?.platform
  const isWindows = platform === 'windows'
  const isMacOS = platform === 'macos'
  const [trail, setTrail] = useState<ArchiveInputTreeEntry[]>([])
  const [childrenByPath, setChildrenByPath] = useState<Record<string, ChildState>>({})
  const defaultMethod: SevenZipOverrideMethod = defaultLevel === 0 ? 'copy' : 'lzma2'
  const defaultCompressionLevel: SevenZipCompressionLevel = SEVEN_ZIP_LEVELS.includes(defaultLevel as SevenZipCompressionLevel)
    ? defaultLevel as SevenZipCompressionLevel
    : 1

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const matchingRule = (sourcePath: string, scope: SevenZipMethodOverride['scope']) => {
    for (let index = overrides.length - 1; index >= 0; index -= 1) {
      const rule = overrides[index]
      if (rule.scope === scope &&
          comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)) {
        return rule
      }
    }
    return undefined
  }

  const containingTreeRule = (
    sourcePath: string,
    predicate: (rule: SevenZipMethodOverride) => boolean = () => true
  ): SevenZipMethodOverride | undefined => {
    let winner: SevenZipMethodOverride | undefined
    for (const rule of overrides) {
      if (rule.scope !== 'tree' || !predicate(rule) || !isDescendant(rule.sourcePath, sourcePath, isWindows)) continue
      if (!winner || comparablePath(rule.sourcePath, isWindows).length >= comparablePath(winner.sourcePath, isWindows).length) {
        winner = rule
      }
    }
    return winner
  }

  const effectiveMethod = (sourcePath: string, isDirectory: boolean): SevenZipOverrideMethod => {
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    return directRule?.method ?? containingTreeRule(sourcePath)?.method ?? defaultMethod
  }

  const selectionFor = (sourcePath: string, isDirectory: boolean): MethodSelection => {
    const method = effectiveMethod(sourcePath, isDirectory)
    if (!isDirectory) return method

    const methods = new Set<SevenZipOverrideMethod>([method])
    for (const rule of overrides) {
      if (isDescendant(sourcePath, rule.sourcePath, isWindows)) methods.add(rule.method)
    }
    return methods.size > 1 ? 'mixed' : method
  }

  const methodLabel = (method: SevenZipOverrideMethod): string => {
    if (method === 'auto') return t('compression.sevenZipOverridesAutomatic')
    if (method === 'copy') return t('compression.methodCopy')
    return t('compression.methodLzma2')
  }

  const levelLabel = (level: SevenZipCompressionLevel): string => {
    if (level === 1) return t('compression.levelFastest', { level })
    if (level === 3) return t('compression.levelFast', { level })
    if (level === 5) return t('compression.levelNormal', { level })
    if (level === 7) return t('compression.levelMaximum', { level })
    return t('compression.levelUltra', { level })
  }

  const optionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<MethodSelection>[] => {
    const selection = selectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.sevenZipOverridesMixed'), disabled: true }]
        : []),
      { value: 'auto', label: methodLabel('auto') },
      { value: 'lzma2', label: methodLabel('lzma2') },
      { value: 'copy', label: methodLabel('copy') }
    ]
  }

  const effectiveCompressionLevel = (
    sourcePath: string,
    isDirectory: boolean
  ): SevenZipCompressionLevel => {
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    return directRule?.level ??
      containingTreeRule(sourcePath, rule => rule.level !== undefined)?.level ??
      defaultCompressionLevel
  }

  const levelSelectionFor = (sourcePath: string, isDirectory: boolean): LevelSelection | null => {
    if (selectionFor(sourcePath, isDirectory) === 'mixed' || effectiveMethod(sourcePath, isDirectory) === 'copy') {
      return null
    }
    const baseLevel = effectiveCompressionLevel(sourcePath, isDirectory)
    if (!isDirectory) return baseLevel

    const levels = new Set<SevenZipCompressionLevel>([baseLevel])
    for (const rule of overrides) {
      if (rule.level !== undefined && isDescendant(sourcePath, rule.sourcePath, isWindows)) {
        levels.add(rule.level)
      }
    }
    return levels.size > 1 ? 'mixed' : baseLevel
  }

  const levelOptionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<LevelSelection>[] => {
    const selection = levelSelectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.zipOverridesLevelMixed'), disabled: true }]
        : []),
      ...SEVEN_ZIP_LEVELS.map(level => ({ value: level, label: levelLabel(level) }))
    ]
  }

  const setMethod = (sourcePath: string, isDirectory: boolean, method: MethodSelection) => {
    if (method === 'mixed') return
    const scope: SevenZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const directRule = matchingRule(sourcePath, scope)
    const remaining = overrides.filter(rule => !(
      (rule.scope === scope &&
       comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)) ||
      (isDirectory && isDescendant(sourcePath, rule.sourcePath, isWindows))
    ))
    onChange([...remaining, {
      sourcePath,
      scope,
      method,
      ...(method !== 'copy' && directRule?.level !== undefined ? { level: directRule.level } : {}),
      ...(method !== 'copy' && directRule?.dictionarySize !== undefined
        ? { dictionarySize: directRule.dictionarySize }
        : {}),
      ...(method !== 'copy' && directRule?.matchFinderWordSize !== undefined
        ? { matchFinderWordSize: directRule.matchFinderWordSize }
        : {}),
      ...(method !== 'copy' && directRule?.searchCycles !== undefined
        ? { searchCycles: directRule.searchCycles }
        : {})
    }])
  }

  const setLevel = (sourcePath: string, isDirectory: boolean, level: LevelSelection) => {
    if (level === 'mixed') return
    const scope: SevenZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const isDirect = (rule: SevenZipMethodOverride) => (
      rule.scope === scope &&
      comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)
    )
    const stripLevel = (rule: SevenZipMethodOverride): SevenZipMethodOverride => {
      const next = { ...rule }
      delete next.level
      return next
    }

    const directRule = matchingRule(sourcePath, scope)
    const method = directRule?.method ?? effectiveMethod(sourcePath, isDirectory)
    if (method === 'copy') return
    const base = overrides
      .filter(rule => !isDirect(rule))
      .map(rule => isDirectory && isDescendant(sourcePath, rule.sourcePath, isWindows) ? stripLevel(rule) : rule)
    onChange([...base, {
      ...(directRule ?? { sourcePath, scope, method }),
      sourcePath,
      scope,
      method,
      level
    }])
  }

  const openDirectory = async (entry: ArchiveInputTreeEntry) => {
    setTrail(current => [...current, entry])
    if (childrenByPath[entry.path]?.status === 'loaded') return
    setChildrenByPath(current => ({
      ...current,
      [entry.path]: { status: 'loading', entries: [] }
    }))
    try {
      const entries = await (window as any).electronAPI.listArchiveInputChildren(entry.path)
      setChildrenByPath(current => ({
        ...current,
        [entry.path]: { status: 'loaded', entries }
      }))
    } catch {
      setChildrenByPath(current => ({
        ...current,
        [entry.path]: { status: 'error', entries: [] }
      }))
    }
  }

  /** Truncating the trail walks back up; depth zero returns to the roots. */
  const moveToDepth = (depth: number) => setTrail(current => current.slice(0, depth))

  const roots = useMemo<ArchiveInputTreeEntry[]>(() => items.map(item => ({
    path: item.path,
    name: item.name,
    isDirectory: item.isDirectory,
    size: item.size
  })), [items])

  const currentFolder = trail.length > 0 ? trail[trail.length - 1] : undefined
  const currentState = currentFolder ? childrenByPath[currentFolder.path] : undefined
  const visibleEntries = currentFolder ? currentState?.entries ?? [] : roots

  /** How many rules sit under a folder, so its row can advertise what it hides. */
  const nestedOverrideCount = (sourcePath: string): number =>
    overrides.filter(rule => isDescendant(sourcePath, rule.sourcePath, isWindows)).length

  const renderEntry = (entry: ArchiveInputTreeEntry): React.ReactNode => {
    const levelSelection = levelSelectionFor(entry.path, entry.isDirectory)
    const nestedCount = entry.isDirectory ? nestedOverrideCount(entry.path) : 0
    const entryMainContents = (
      <>
        {entry.isDirectory
          ? <Folder className="zip-method-modal__entry-icon zip-method-modal__entry-icon--folder" size={17} />
          : <File className="zip-method-modal__entry-icon" size={17} />}
        <div className="zip-method-modal__entry-text">
          <span className="zip-method-modal__entry-name">{entry.name}</span>
          <span className="zip-method-modal__entry-path">{entry.path}</span>
          {nestedCount > 0 && (
            <span className="zip-method-modal__entry-nested">
              {t('compression.zipOverridesNested', { count: nestedCount })}
            </span>
          )}
        </div>
        {entry.isDirectory && (
          <ChevronRight className="zip-method-modal__entry-chevron" size={15} aria-hidden="true" />
        )}
      </>
    )

    return (
      <div className="zip-method-modal__entry" key={entry.path}>
        {entry.isDirectory ? (
          <button
            type="button"
            className="zip-method-modal__entry-main zip-method-modal__entry-toggle"
            aria-label={t('compression.zipOverridesOpen', { name: entry.name })}
            onClick={() => void openDirectory(entry)}
          >
            {entryMainContents}
          </button>
        ) : (
          <div className="zip-method-modal__entry-main">{entryMainContents}</div>
        )}
        <span className="zip-method-modal__entry-size">
          {entry.isDirectory && currentFolder ? '—' : formatBytes(entry.size, language)}
        </span>
        <div className="zip-method-modal__control zip-method-modal__method">
          <span className="zip-method-modal__control-label" aria-hidden="true">
            {t('compression.zipOverridesMethod')}
          </span>
          <Select<MethodSelection>
            value={selectionFor(entry.path, entry.isDirectory)}
            ariaLabel={t('compression.sevenZipOverridesMethodFor', { name: entry.name })}
            options={optionsFor(entry.path, entry.isDirectory)}
            onChange={value => setMethod(entry.path, entry.isDirectory, value)}
          />
        </div>
        <div className="zip-method-modal__control zip-method-modal__level">
          <span className="zip-method-modal__control-label" aria-hidden="true">
            {t('compression.zipOverridesLevel')}
          </span>
          {levelSelection === null ? (
            <span className="zip-method-modal__level-na">—</span>
          ) : (
            <Select<LevelSelection>
              value={levelSelection}
              ariaLabel={t('compression.zipOverridesLevelFor', { name: entry.name })}
              options={levelOptionsFor(entry.path, entry.isDirectory)}
              onChange={value => setLevel(entry.path, entry.isDirectory, value)}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`zip-method-modal zip-method-modal--seven-zip${isMacOS ? ' zip-method-modal--macos' : ''}`} onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="glass-panel zip-method-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="seven-zip-method-modal-title"
      >
        <header className="zip-method-modal__header">
          <div className="zip-method-modal__heading">
            <span className="zip-method-modal__heading-icon"><Files size={20} /></span>
            <div>
              <h2 id="seven-zip-method-modal-title" className="zip-method-modal__title">
                {t('compression.sevenZipOverridesTitle')}
              </h2>
              <p className="zip-method-modal__description">
                {t('compression.sevenZipOverridesDescription')}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="zip-method-modal__close"
            aria-label={t('compression.sevenZipOverridesClose')}
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="zip-method-modal__notice">{t('compression.sevenZipOverridesSolid')}</div>
        <div className="zip-method-modal__browser">
          <nav className="zip-method-modal__breadcrumbs" aria-label={t('compression.zipOverridesBreadcrumb')}>
            <button
              type="button"
              className={`zip-method-modal__breadcrumb${trail.length === 0 ? ' is-active' : ''}`}
              aria-label={t('compression.zipOverridesRoot')}
              title={t('compression.zipOverridesRoot')}
              onClick={() => moveToDepth(0)}
            >
              <Home size={15} />
            </button>
            {trail.map((entry, index) => (
              <React.Fragment key={entry.path}>
                <ChevronRight className="zip-method-modal__breadcrumb-separator" size={15} aria-hidden="true" />
                <button
                  type="button"
                  className={`zip-method-modal__breadcrumb${index === trail.length - 1 ? ' is-active' : ''}`}
                  onClick={() => moveToDepth(index + 1)}
                >
                  {entry.name}
                </button>
              </React.Fragment>
            ))}
          </nav>

          <div className="zip-method-modal__columns" aria-hidden="true">
            <span>{t('compression.zipOverridesItem')}</span>
            <span>{t('compression.zipOverridesSize')}</span>
            <span>{t('compression.zipOverridesMethod')}</span>
            <span>{t('compression.zipOverridesLevel')}</span>
          </div>
          <div className="zip-method-modal__tree">
            {currentState?.status === 'loading' && (
              <div className="zip-method-modal__branch-state">{t('compression.zipOverridesLoading')}</div>
            )}
            {currentState?.status === 'error' && (
              <div className="zip-method-modal__branch-state zip-method-modal__branch-state--error">
                {t('compression.zipOverridesLoadError')}
              </div>
            )}
            {currentState?.status !== 'loading' && currentState?.status !== 'error' && visibleEntries.length === 0 && (
              <div className="zip-method-modal__branch-state">{t('compression.zipOverridesEmpty')}</div>
            )}
            {visibleEntries.map(entry => renderEntry(entry))}
          </div>
        </div>

        <footer className="zip-method-modal__footer">
          <button
            type="button"
            className="btn-secondary zip-method-modal__reset"
            disabled={overrides.length === 0}
            onClick={() => onChange([])}
          >
            <RotateCcw size={15} />
            {t('compression.zipOverridesReset')}
          </button>
          <span className="zip-method-modal__count">
            {t('compression.zipOverridesCount', { count: overrides.length })}
          </span>
          <button type="button" className="btn-primary zip-method-modal__done" onClick={onClose}>
            {t('compression.zipOverridesDone')}
          </button>
        </footer>
      </section>
    </div>
  )
}
