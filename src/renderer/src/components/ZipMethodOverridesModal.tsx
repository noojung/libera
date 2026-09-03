import React, { useEffect, useMemo, useState } from 'react'
import { ChevronRight, File, Files, Folder, Home, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchiveInputTreeEntry } from '@services/archiveInputTree'
import type { DeflateStrategy, ZipMethodOverride, ZipOverrideMethod } from '@services/compressor'
import type { SelectedItem } from '@/types'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { Select, type SelectOption } from './Select'
import './ZipMethodOverridesModal.css'

type MethodSelection = ZipOverrideMethod | 'mixed'
type StrategySelection = DeflateStrategy | 'mixed'
type LevelSelection = number | 'mixed'
type MemorySelection = number | 'mixed'

const DEFAULT_MEMORY_LEVEL = 8

interface ZipMethodOverridesModalProps {
  items: SelectedItem[]
  overrides: ZipMethodOverride[]
  defaultLevel: number
  onChange: (overrides: ZipMethodOverride[]) => void
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

export const ZipMethodOverridesModal: React.FC<ZipMethodOverridesModalProps> = ({
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const methodLabel = (method: ZipOverrideMethod): string => {
    if (method === 'auto') return t('compression.zipOverridesAutomatic')
    if (method === 'store') return t('compression.methodStore')
    if (method === 'lzma') return t('compression.methodZipLzma')
    if (method === 'zstd') return t('compression.methodZipZstd')
    return t('compression.methodDeflate')
  }

  const strategyLabel = (strategy: DeflateStrategy): string => {
    if (strategy === 'filtered') return t('compression.strategyFiltered')
    if (strategy === 'huffman_only') return t('compression.strategyHuffman')
    if (strategy === 'rle') return t('compression.strategyRle')
    if (strategy === 'fixed') return t('compression.strategyFixed')
    return t('compression.strategyDefault')
  }

  const levelLabel = (level: number): string => {
    if (level === 0) return t('compression.levelStore', { level })
    if (level === 1) return t('compression.levelFastest', { level })
    if (level === 6) return t('compression.levelNormal', { level })
    if (level === 9) return t('compression.levelMaximum', { level })
    return t('compression.levelPlain', { level })
  }

  const matchingRule = (sourcePath: string, scope: ZipMethodOverride['scope']) => {
    for (let index = overrides.length - 1; index >= 0; index -= 1) {
      const rule = overrides[index]
      if (rule.scope === scope && comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)) {
        return rule
      }
    }
    return undefined
  }

  const inheritedTreeRule = (
    sourcePath: string,
    predicate: (rule: ZipMethodOverride) => boolean = () => true
  ): ZipMethodOverride | undefined => {
    let winner: ZipMethodOverride | undefined
    for (const rule of overrides) {
      if (rule.scope !== 'tree' || !predicate(rule) || !isDescendant(rule.sourcePath, sourcePath, isWindows)) continue
      if (!winner || comparablePath(rule.sourcePath, isWindows).length >= comparablePath(winner.sourcePath, isWindows).length) {
        winner = rule
      }
    }
    return winner
  }

  /** How many rules sit under a folder, so its row can advertise what it hides. */
  const nestedOverrideCount = (sourcePath: string): number =>
    overrides.filter(rule => isDescendant(sourcePath, rule.sourcePath, isWindows)).length

  const effectiveMethod = (sourcePath: string, isDirectory: boolean): ZipOverrideMethod => {
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    if (directRule) return directRule.method
    return inheritedTreeRule(sourcePath)?.method ?? 'auto'
  }

  const selectionFor = (sourcePath: string, isDirectory: boolean): MethodSelection => {
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    if (!isDirectory) return directRule?.method ?? effectiveMethod(sourcePath, false)

    const methods = new Set<ZipOverrideMethod>([directRule?.method ?? effectiveMethod(sourcePath, true)])
    for (const rule of overrides) {
      if (isDescendant(sourcePath, rule.sourcePath, isWindows)) methods.add(rule.method)
    }
    if (methods.size > 1) return 'mixed'
    return directRule?.method ?? effectiveMethod(sourcePath, true)
  }

  const optionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<MethodSelection>[] => {
    const selection = selectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.zipOverridesMixed'), disabled: true }]
        : []),
      { value: 'auto', label: methodLabel('auto') },
      { value: 'store', label: methodLabel('store') },
      { value: 'deflate', label: methodLabel('deflate') },
      { value: 'lzma', label: methodLabel('lzma') },
      { value: 'zstd', label: methodLabel('zstd') }
    ]
  }

  const strategySelectionFor = (sourcePath: string, isDirectory: boolean): StrategySelection | null => {
    const method = effectiveMethod(sourcePath, isDirectory)
    if (selectionFor(sourcePath, isDirectory) === 'mixed' || (method !== 'auto' && method !== 'deflate')) return null
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    const inheritedRule = inheritedTreeRule(sourcePath, rule => rule.deflateStrategy !== undefined)
    const baseStrategy = directRule?.deflateStrategy ?? inheritedRule?.deflateStrategy ?? 'default'
    if (!isDirectory) return baseStrategy

    const strategies = new Set<DeflateStrategy>([baseStrategy])
    for (const rule of overrides) {
      if ((rule.method === 'auto' || rule.method === 'deflate') && rule.deflateStrategy !== undefined &&
          isDescendant(sourcePath, rule.sourcePath, isWindows)) {
        strategies.add(rule.deflateStrategy)
      }
    }
    if (strategies.size > 1) return 'mixed'
    return baseStrategy
  }

  const strategyOptionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<StrategySelection>[] => {
    const selection = strategySelectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.zipOverridesStrategyMixed'), disabled: true }]
        : []),
      { value: 'default', label: strategyLabel('default') },
      { value: 'filtered', label: strategyLabel('filtered') },
      { value: 'huffman_only', label: strategyLabel('huffman_only') },
      { value: 'rle', label: strategyLabel('rle') },
      { value: 'fixed', label: strategyLabel('fixed') }
    ]
  }

  const memorySelectionFor = (sourcePath: string, isDirectory: boolean): MemorySelection | null => {
    const method = effectiveMethod(sourcePath, isDirectory)
    if (selectionFor(sourcePath, isDirectory) === 'mixed' || (method !== 'auto' && method !== 'deflate')) return null
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    const inheritedRule = inheritedTreeRule(sourcePath, rule => rule.memLevel !== undefined)
    const baseMemory = directRule?.memLevel ?? inheritedRule?.memLevel ?? DEFAULT_MEMORY_LEVEL
    if (!isDirectory) return baseMemory

    const memoryLevels = new Set<number>([baseMemory])
    for (const rule of overrides) {
      if ((rule.method === 'auto' || rule.method === 'deflate') && rule.memLevel !== undefined &&
          isDescendant(sourcePath, rule.sourcePath, isWindows)) {
        memoryLevels.add(rule.memLevel)
      }
    }
    return memoryLevels.size > 1 ? 'mixed' : baseMemory
  }

  const memoryOptionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<MemorySelection>[] => {
    const selection = memorySelectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.zipOverridesMemoryMixed'), disabled: true }]
        : []),
      ...Array.from({ length: 9 }, (_, index) => ({ value: index + 1, label: String(index + 1) }))
    ]
  }

  const effectiveCompressionLevel = (sourcePath: string, isDirectory: boolean): number => {
    const inheritedLevel = inheritedTreeRule(sourcePath, rule => rule.level !== undefined)?.level
    if (inheritedLevel !== undefined) return inheritedLevel
    if (defaultLevel > 0) return defaultLevel

    // A forced codec cannot use Store-level zero. Automatic remains allowed
    // to show zero because it means every entry will be stored.
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    const inheritedRule = inheritedTreeRule(sourcePath)
    const explicitMethod = directRule?.method ?? inheritedRule?.method
    return explicitMethod !== undefined && explicitMethod !== 'store' && explicitMethod !== 'auto' ? 1 : 0
  }

  const levelSelectionFor = (sourcePath: string, isDirectory: boolean): LevelSelection | null => {
    if (selectionFor(sourcePath, isDirectory) === 'mixed' || effectiveMethod(sourcePath, isDirectory) === 'store') return null
    const directRule = matchingRule(sourcePath, isDirectory ? 'tree' : 'file')
    const baseLevel = directRule?.level ?? effectiveCompressionLevel(sourcePath, isDirectory)
    if (!isDirectory) return baseLevel

    const levels = new Set<number>([baseLevel])
    for (const rule of overrides) {
      if (rule.level !== undefined && isDescendant(sourcePath, rule.sourcePath, isWindows)) levels.add(rule.level)
    }
    if (levels.size > 1) return 'mixed'
    return baseLevel
  }

  const levelOptionsFor = (sourcePath: string, isDirectory: boolean): SelectOption<LevelSelection>[] => {
    const method = effectiveMethod(sourcePath, isDirectory)
    const selection = levelSelectionFor(sourcePath, isDirectory)
    return [
      ...(selection === 'mixed'
        ? [{ value: 'mixed' as const, label: t('compression.zipOverridesLevelMixed'), disabled: true }]
        : []),
      ...Array.from({ length: method === 'auto' ? 10 : 9 }, (_, index) => {
        const level = method === 'auto' ? index : index + 1
        return { value: level, label: levelLabel(level) }
      })
    ]
  }

  const setMethod = (sourcePath: string, isDirectory: boolean, selection: MethodSelection) => {
    if (selection === 'mixed') return
    const scope: ZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const directRule = matchingRule(sourcePath, scope)
    const inheritedLevel = inheritedTreeRule(sourcePath, rule => rule.level !== undefined)?.level
    const withoutDirect = overrides.filter(rule => !(
      rule.scope === scope &&
      comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)
    ))

    const base = isDirectory
      ? withoutDirect.filter(rule => !isDescendant(sourcePath, rule.sourcePath, isWindows))
      : withoutDirect
    onChange([...base, {
      sourcePath,
      scope,
      method: selection,
      ...(selection === 'deflate' || selection === 'auto'
        ? directRule?.deflateStrategy !== undefined ? { deflateStrategy: directRule.deflateStrategy } : {}
        : {}),
      ...(selection === 'deflate' || selection === 'auto'
        ? directRule?.memLevel !== undefined ? { memLevel: directRule.memLevel } : {}
        : {}),
      ...(selection !== 'store'
        ? directRule?.level !== undefined
          ? { level: selection !== 'auto' && directRule.level === 0 ? 1 : directRule.level }
          : selection !== 'auto' && inheritedLevel === undefined && defaultLevel === 0 ? { level: 1 } : {}
        : {})
    }])
  }

  const setStrategy = (sourcePath: string, isDirectory: boolean, strategy: StrategySelection) => {
    if (strategy === 'mixed') return
    const scope: ZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const directRule = matchingRule(sourcePath, scope)
    const inheritedLevel = inheritedTreeRule(sourcePath, rule => rule.level !== undefined)?.level
    const withoutDirect = overrides.filter(rule => !(
      rule.scope === scope &&
      comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)
    ))
    const base = withoutDirect.map(rule => {
      if (!isDirectory || !isDescendant(sourcePath, rule.sourcePath, isWindows) || rule.deflateStrategy === undefined) return rule
      const next = { ...rule }
      delete next.deflateStrategy
      return next
    })
    const method = directRule?.method ?? effectiveMethod(sourcePath, isDirectory)
    if (method !== 'auto' && method !== 'deflate') return
    onChange([...base, {
      sourcePath,
      scope,
      method,
      deflateStrategy: strategy,
      ...(directRule?.memLevel !== undefined ? { memLevel: directRule.memLevel } : {}),
      ...(directRule?.level !== undefined
        ? { level: directRule.level }
        : method !== 'auto' && inheritedLevel === undefined && defaultLevel === 0 ? { level: 1 } : {})
    }])
  }

  const setMemory = (sourcePath: string, isDirectory: boolean, memLevel: MemorySelection) => {
    if (memLevel === 'mixed') return
    const scope: ZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const isDirect = (rule: ZipMethodOverride) => (
      rule.scope === scope &&
      comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)
    )
    const stripMemory = (rule: ZipMethodOverride): ZipMethodOverride => {
      const next = { ...rule }
      delete next.memLevel
      return next
    }

    const directRule = matchingRule(sourcePath, scope)
    const method = directRule?.method ?? effectiveMethod(sourcePath, isDirectory)
    if (method !== 'auto' && method !== 'deflate') return
    const base = overrides
      .filter(rule => !isDirect(rule))
      .map(rule => isDirectory && isDescendant(sourcePath, rule.sourcePath, isWindows) ? stripMemory(rule) : rule)
    onChange([...base, {
      ...(directRule ?? { sourcePath, scope, method }),
      sourcePath,
      scope,
      method,
      memLevel
    }])
  }

  const setLevel = (sourcePath: string, isDirectory: boolean, level: LevelSelection) => {
    if (level === 'mixed') return
    const scope: ZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const isDirect = (rule: ZipMethodOverride) => (
      rule.scope === scope &&
      comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)
    )
    const stripLevel = (rule: ZipMethodOverride): ZipMethodOverride => {
      const next = { ...rule }
      delete next.level
      return next
    }

    const directRule = matchingRule(sourcePath, scope)
    const base = overrides
      .filter(rule => !isDirect(rule))
      .map(rule => isDirectory && isDescendant(sourcePath, rule.sourcePath, isWindows) ? stripLevel(rule) : rule)
    const method = directRule?.method ?? effectiveMethod(sourcePath, isDirectory)
    if (method === 'store') return
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

  const renderEntry = (entry: ArchiveInputTreeEntry): React.ReactNode => {
    const selection = selectionFor(entry.path, entry.isDirectory)
    const strategySelection = strategySelectionFor(entry.path, entry.isDirectory)
    const levelSelection = levelSelectionFor(entry.path, entry.isDirectory)
    const memorySelection = memorySelectionFor(entry.path, entry.isDirectory)
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
            value={selection}
            ariaLabel={t('compression.zipOverridesMethodFor', { name: entry.name })}
            options={optionsFor(entry.path, entry.isDirectory)}
            onChange={value => setMethod(entry.path, entry.isDirectory, value)}
          />
        </div>
        <div className="zip-method-modal__control zip-method-modal__strategy">
          <span className="zip-method-modal__control-label" aria-hidden="true">
            {t('compression.zipOverridesStrategy')}
          </span>
          {strategySelection === null ? (
            <span className="zip-method-modal__strategy-na">—</span>
          ) : (
            <Select<StrategySelection>
              value={strategySelection}
              ariaLabel={t('compression.zipOverridesStrategyFor', { name: entry.name })}
              options={strategyOptionsFor(entry.path, entry.isDirectory)}
              onChange={value => setStrategy(entry.path, entry.isDirectory, value)}
            />
          )}
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
        <div className="zip-method-modal__control zip-method-modal__memory">
          <span className="zip-method-modal__control-label" aria-hidden="true">
            {t('compression.zipOverridesMemory')}
          </span>
          {memorySelection === null ? (
            <span className="zip-method-modal__memory-na">—</span>
          ) : (
            <Select<MemorySelection>
              value={memorySelection}
              ariaLabel={t('compression.zipOverridesMemoryFor', { name: entry.name })}
              options={memoryOptionsFor(entry.path, entry.isDirectory)}
              onChange={value => setMemory(entry.path, entry.isDirectory, value)}
            />
          )}
        </div>
      </div>
    )
  }


  return (
    <div className={`zip-method-modal${isMacOS ? ' zip-method-modal--macos' : ''}`} onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        className="glass-panel zip-method-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zip-method-modal-title"
      >
        <header className="zip-method-modal__header">
          <div className="zip-method-modal__heading">
            <span className="zip-method-modal__heading-icon"><Files size={20} /></span>
            <div>
              <h2 id="zip-method-modal-title" className="zip-method-modal__title">{t('compression.zipOverridesTitle')}</h2>
              <p className="zip-method-modal__description">
                {t('compression.zipOverridesDescription')}
              </p>
            </div>
          </div>
          <button type="button" className="zip-method-modal__close" aria-label={t('compression.zipOverridesClose')} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="zip-method-modal__notice">{t('compression.zipOverridesCompatibility')}</div>

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
          <span>{t('compression.zipOverridesStrategy')}</span>
          <span>{t('compression.zipOverridesLevel')}</span>
          <span>{t('compression.zipOverridesMemory')}</span>
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

        <footer className="zip-method-modal__footer">
          <button type="button" className="btn-secondary zip-method-modal__reset" disabled={overrides.length === 0} onClick={() => onChange([])}>
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
