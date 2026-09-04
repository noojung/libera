import path from 'path'

export type SevenZipMethod = 'lzma2' | 'copy'
export type SevenZipCompressionLevel = 1 | 3 | 5 | 7 | 9
export type SevenZipDictionarySize = 'auto' | number
export type SevenZipMatchFinderWordSize = 32 | 64 | 128 | 273

export interface SevenZipMethodOverride {
  sourcePath: string
  scope: 'file' | 'tree'
  method: SevenZipMethod
  level?: SevenZipCompressionLevel
  dictionarySize?: SevenZipDictionarySize
  matchFinderWordSize?: SevenZipMatchFinderWordSize
  searchCycles?: number
}

export interface ResolvedSevenZipMethod {
  method: SevenZipMethod
  explicit: boolean
  level?: SevenZipCompressionLevel
  dictionarySize?: SevenZipDictionarySize
  matchFinderWordSize?: SevenZipMatchFinderWordSize
  searchCycles?: number
}

const METHODS = new Set<SevenZipMethod>(['lzma2', 'copy'])
const LEVELS = new Set<SevenZipCompressionLevel>([1, 3, 5, 7, 9])
const MATCH_FINDER_WORD_SIZES = new Set<SevenZipMatchFinderWordSize>([32, 64, 128, 273])
const MIN_DICTIONARY_SIZE = 64 * 1024
const MAX_DICTIONARY_SIZE = 128 * 1024 * 1024

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrChild(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isSevenZipMethod(value: unknown): value is SevenZipMethod {
  return typeof value === 'string' && METHODS.has(value as SevenZipMethod)
}

export function validateSevenZipMethodOverrides(
  overrides: readonly SevenZipMethodOverride[] | undefined,
  inputPaths: readonly string[]
): void {
  if (overrides === undefined) return
  if (!Array.isArray(overrides)) throw new TypeError('7Z method overrides must be an array.')

  const roots = inputPaths.map(normalizedPath)
  for (const override of overrides) {
    if (!override || typeof override.sourcePath !== 'string' || override.sourcePath.length === 0) {
      throw new TypeError('Each 7Z method override must name a source path.')
    }
    if (override.scope !== 'file' && override.scope !== 'tree') {
      throw new RangeError('7Z method override scope is unsupported.')
    }
    if (!isSevenZipMethod(override.method)) {
      throw new RangeError('7Z method override is unsupported.')
    }
    if (override.method === 'copy' && (
      override.level !== undefined ||
      override.dictionarySize !== undefined ||
      override.matchFinderWordSize !== undefined ||
      override.searchCycles !== undefined
    )) {
      throw new RangeError('Copy cannot use 7Z compression tuning.')
    }
    if (override.level !== undefined && !LEVELS.has(override.level)) {
      throw new RangeError('7Z compression level override is unsupported.')
    }
    if (override.dictionarySize !== undefined && override.dictionarySize !== 'auto' && (
      !Number.isInteger(override.dictionarySize) ||
      override.dictionarySize < MIN_DICTIONARY_SIZE ||
      override.dictionarySize > MAX_DICTIONARY_SIZE
    )) {
      throw new RangeError('7Z dictionary size override is unsupported.')
    }
    if (override.matchFinderWordSize !== undefined && !MATCH_FINDER_WORD_SIZES.has(override.matchFinderWordSize)) {
      throw new RangeError('7Z match finder word size override is unsupported.')
    }
    if (override.searchCycles !== undefined && (
      !Number.isInteger(override.searchCycles) || override.searchCycles < 1 || override.searchCycles > 1024
    )) {
      throw new RangeError('7Z search cycles override is unsupported.')
    }

    const sourcePath = normalizedPath(override.sourcePath)
    if (!roots.some(rootPath => isSameOrChild(rootPath, sourcePath))) {
      throw new RangeError('7Z method override must be inside a selected input.')
    }
  }
}

/** Exact file rules win; otherwise the nearest recursive directory rule wins. */
export function resolveSevenZipMethod(
  sourcePath: string,
  defaultMethod: SevenZipMethod,
  overrides: readonly SevenZipMethodOverride[] | undefined
): ResolvedSevenZipMethod {
  if (!overrides?.length) return { method: defaultMethod, explicit: false }

  const candidatePath = normalizedPath(sourcePath)
  const contenders: Array<{
    rule: SevenZipMethodOverride
    exact: boolean
    depth: number
    index: number
  }> = []

  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index]
    const overridePath = normalizedPath(override.sourcePath)
    const exact = overridePath === candidatePath
    if (override.scope === 'file' && !exact) continue
    if (override.scope === 'tree' && !isSameOrChild(overridePath, candidatePath)) continue
    contenders.push({
      rule: override,
      exact: override.scope === 'file' && exact,
      depth: overridePath.length,
      index
    })
  }

  contenders.sort((left, right) => (
    Number(right.exact) - Number(left.exact) ||
    right.depth - left.depth ||
    right.index - left.index
  ))
  const method = contenders[0]?.rule.method ?? defaultMethod
  if (method === 'copy') return { method, explicit: contenders.length > 0 }

  const inherited = <Key extends 'level' | 'dictionarySize' | 'matchFinderWordSize' | 'searchCycles'>(key: Key) =>
    contenders.find(contender => contender.rule[key] !== undefined)?.rule[key]
  return {
    method,
    explicit: contenders.length > 0,
    ...(inherited('level') !== undefined ? { level: inherited('level') } : {}),
    ...(inherited('dictionarySize') !== undefined ? { dictionarySize: inherited('dictionarySize') } : {}),
    ...(inherited('matchFinderWordSize') !== undefined
      ? { matchFinderWordSize: inherited('matchFinderWordSize') }
      : {}),
    ...(inherited('searchCycles') !== undefined ? { searchCycles: inherited('searchCycles') } : {})
  }
}
