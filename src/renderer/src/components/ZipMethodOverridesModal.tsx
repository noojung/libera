import React, { useEffect, useMemo, useState } from 'react'
import { Archive, ChevronDown, File, Folder, RotateCcw, X } from 'lucide-react'
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

function depthClass(depth: number): string {
  return `zip-method-modal__depth-${Math.min(8, Math.max(0, depth))}`
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
  const isWindows = (window as any).electronAPI?.platform === 'windows'
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
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
      ...(directRule?.level !== undefined
        ? { level: directRule.level }
        : method !== 'auto' && inheritedLevel === undefined && defaultLevel === 0 ? { level: 1 } : {})
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

  const toggleDirectory = async (directoryPath: string) => {
    if (expandedPaths.has(directoryPath)) {
      setExpandedPaths(current => {
        const next = new Set(current)
        next.delete(directoryPath)
        return next
      })
      return
    }

    setExpandedPaths(current => new Set(current).add(directoryPath))
    if (childrenByPath[directoryPath]?.status === 'loaded') return

    setChildrenByPath(current => ({
      ...current,
      [directoryPath]: { status: 'loading', entries: [] }
    }))
    try {
      const entries = await (window as any).electronAPI.listArchiveInputChildren(directoryPath)
      setChildrenByPath(current => ({
        ...current,
        [directoryPath]: { status: 'loaded', entries }
      }))
    } catch {
      setChildrenByPath(current => ({
        ...current,
        [directoryPath]: { status: 'error', entries: [] }
      }))
    }
  }

  const roots = useMemo<ArchiveInputTreeEntry[]>(() => items.map(item => ({
    path: item.path,
    name: item.name,
    isDirectory: item.isDirectory,
    size: item.size
  })), [items])

  const renderEntry = (entry: ArchiveInputTreeEntry, depth: number): React.ReactNode => {
    const expanded = expandedPaths.has(entry.path)
    const childState = childrenByPath[entry.path]
    const selection = selectionFor(entry.path, entry.isDirectory)
    const strategySelection = strategySelectionFor(entry.path, entry.isDirectory)
    const levelSelection = levelSelectionFor(entry.path, entry.isDirectory)
    const entryMainContents = (
      <>
        {entry.isDirectory ? (
          <span className="zip-method-modal__expand" aria-hidden="true">
            <ChevronDown className={expanded ? 'is-expanded' : ''} size={15} />
          </span>
        ) : (
          <span className="zip-method-modal__expand-spacer" />
        )}
        {entry.isDirectory
          ? <Folder className="zip-method-modal__entry-icon zip-method-modal__entry-icon--folder" size={17} />
          : <File className="zip-method-modal__entry-icon" size={17} />}
        <div className="zip-method-modal__entry-text">
          <span className="zip-method-modal__entry-name">{entry.name}</span>
          <span className="zip-method-modal__entry-path">{entry.path}</span>
        </div>
      </>
    )
    return (
      <React.Fragment key={entry.path}>
        <div className={`zip-method-modal__entry ${depthClass(depth)}`}>
          {entry.isDirectory ? (
            <button
              type="button"
              className="zip-method-modal__entry-main zip-method-modal__entry-toggle"
              aria-label={t(expanded ? 'compression.zipOverridesCollapse' : 'compression.zipOverridesExpand', { name: entry.name })}
              aria-expanded={expanded}
              onClick={() => void toggleDirectory(entry.path)}
            >
              {entryMainContents}
            </button>
          ) : (
            <div className="zip-method-modal__entry-main">{entryMainContents}</div>
          )}
          <span className="zip-method-modal__entry-size">
            {entry.isDirectory && depth > 0 ? '—' : formatBytes(entry.size, language)}
          </span>
          <Select<MethodSelection>
            value={selection}
            ariaLabel={t('compression.zipOverridesMethodFor', { name: entry.name })}
            rootClassName="zip-method-modal__method"
            options={optionsFor(entry.path, entry.isDirectory)}
            onChange={value => setMethod(entry.path, entry.isDirectory, value)}
          />
          {strategySelection === null ? (
            <span className="zip-method-modal__strategy-na">—</span>
          ) : (
            <Select<StrategySelection>
              value={strategySelection}
              ariaLabel={t('compression.zipOverridesStrategyFor', { name: entry.name })}
              rootClassName="zip-method-modal__strategy"
              options={strategyOptionsFor(entry.path, entry.isDirectory)}
              onChange={value => setStrategy(entry.path, entry.isDirectory, value)}
            />
          )}
          {levelSelection === null ? (
            <span className="zip-method-modal__level-na">—</span>
          ) : (
            <Select<LevelSelection>
              value={levelSelection}
              ariaLabel={t('compression.zipOverridesLevelFor', { name: entry.name })}
              rootClassName="zip-method-modal__level"
              options={levelOptionsFor(entry.path, entry.isDirectory)}
              onChange={value => setLevel(entry.path, entry.isDirectory, value)}
            />
          )}
        </div>
        {entry.isDirectory && expanded && (
          <div role="group" aria-label={entry.name}>
            {childState?.status === 'loading' && (
              <div className={`zip-method-modal__branch-state ${depthClass(depth + 1)}`}>
                {t('compression.zipOverridesLoading')}
              </div>
            )}
            {childState?.status === 'error' && (
              <div className={`zip-method-modal__branch-state zip-method-modal__branch-state--error ${depthClass(depth + 1)}`}>
                {t('compression.zipOverridesLoadError')}
              </div>
            )}
            {childState?.status === 'loaded' && childState.entries.length === 0 && (
              <div className={`zip-method-modal__branch-state ${depthClass(depth + 1)}`}>
                {t('compression.zipOverridesEmpty')}
              </div>
            )}
            {childState?.status === 'loaded' && childState.entries.map(child => renderEntry(child, depth + 1))}
          </div>
        )}
      </React.Fragment>
    )
  }

  return (
    <div className="zip-method-modal" onMouseDown={event => {
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
            <span className="zip-method-modal__heading-icon"><Archive size={20} /></span>
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

        <div className="zip-method-modal__columns" aria-hidden="true">
          <span>{t('compression.zipOverridesItem')}</span>
          <span>{t('compression.zipOverridesSize')}</span>
          <span>{t('compression.zipOverridesMethod')}</span>
          <span>{t('compression.zipOverridesStrategy')}</span>
          <span>{t('compression.zipOverridesLevel')}</span>
        </div>
        <div className="zip-method-modal__tree">
          {roots.map(root => renderEntry(root, 0))}
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
