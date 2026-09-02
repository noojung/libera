import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, File, Files, Folder, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArchiveInputTreeEntry } from '@services/archiveInputTree'
import type { SevenZipMethodOverride, SevenZipOverrideMethod } from '@services/compressor'
import type { SelectedItem } from '@/types'
import { formatBytes } from '@/i18n/format'
import type { AppLanguage } from '@/i18n/language'
import { Select, type SelectOption } from './Select'
import './ZipMethodOverridesModal.css'

type MethodSelection = SevenZipOverrideMethod | 'mixed'

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

function depthClass(depth: number): string {
  return `zip-method-modal__depth-${Math.min(8, Math.max(0, depth))}`
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [childrenByPath, setChildrenByPath] = useState<Record<string, ChildState>>({})
  const defaultMethod: SevenZipOverrideMethod = defaultLevel === 0 ? 'copy' : 'lzma2'

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

  const containingTreeRule = (sourcePath: string): SevenZipMethodOverride | undefined => {
    let winner: SevenZipMethodOverride | undefined
    for (const rule of overrides) {
      if (rule.scope !== 'tree' || !isDescendant(rule.sourcePath, sourcePath, isWindows)) continue
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

  const setMethod = (sourcePath: string, isDirectory: boolean, method: MethodSelection) => {
    if (method === 'mixed') return
    const scope: SevenZipMethodOverride['scope'] = isDirectory ? 'tree' : 'file'
    const remaining = overrides.filter(rule => !(
      (rule.scope === scope &&
       comparablePath(rule.sourcePath, isWindows) === comparablePath(sourcePath, isWindows)) ||
      (isDirectory && isDescendant(sourcePath, rule.sourcePath, isWindows))
    ))
    onChange([...remaining, { sourcePath, scope, method }])
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
        <div className="zip-method-modal__columns" aria-hidden="true">
          <span>{t('compression.zipOverridesItem')}</span>
          <span>{t('compression.zipOverridesSize')}</span>
          <span>{t('compression.zipOverridesMethod')}</span>
        </div>
        <div className="zip-method-modal__tree">
          {roots.map(root => renderEntry(root, 0))}
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
