import path from 'path'

export type ZipMethod = 'deflate' | 'store' | 'lzma' | 'zstd'
export type ZipOverrideMethod = 'auto' | ZipMethod
export type DeflateStrategy = 'default' | 'filtered' | 'huffman_only' | 'rle' | 'fixed'

export interface ZipMethodOverride {
  sourcePath: string
  scope: 'file' | 'tree'
  method: ZipOverrideMethod
  deflateStrategy?: DeflateStrategy
  /** Per-entry zlib working-memory level. Only Automatic and Deflate use it. */
  memLevel?: number
  /** Per-entry compression strength. Store has no level; compressed methods use 1-9. */
  level?: number
}

export interface ResolvedZipMethod {
  method: ZipOverrideMethod
  explicit: boolean
  deflateStrategy?: DeflateStrategy
  memLevel?: number
  level?: number
}

const ZIP_METHODS = new Set<ZipMethod>(['deflate', 'store', 'lzma', 'zstd'])
const ZIP_OVERRIDE_METHODS = new Set<ZipOverrideMethod>(['auto', ...ZIP_METHODS])
const DEFLATE_STRATEGIES = new Set<DeflateStrategy>(['default', 'filtered', 'huffman_only', 'rle', 'fixed'])

function normalizedPath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSameOrChild(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isZipMethod(value: unknown): value is ZipMethod {
  return typeof value === 'string' && ZIP_METHODS.has(value as ZipMethod)
}

export function isZipOverrideMethod(value: unknown): value is ZipOverrideMethod {
  return typeof value === 'string' && ZIP_OVERRIDE_METHODS.has(value as ZipOverrideMethod)
}

export function validateZipMethodOverrides(
  overrides: readonly ZipMethodOverride[] | undefined,
  inputPaths: readonly string[]
): void {
  if (overrides === undefined) return
  if (!Array.isArray(overrides)) throw new TypeError('ZIP method overrides must be an array.')

  const roots = inputPaths.map(normalizedPath)
  for (const override of overrides) {
    if (!override || typeof override.sourcePath !== 'string' || override.sourcePath.length === 0) {
      throw new TypeError('Each ZIP method override must name a source path.')
    }
    if (override.scope !== 'file' && override.scope !== 'tree') {
      throw new RangeError('ZIP method override scope is unsupported.')
    }
    if (!isZipOverrideMethod(override.method)) {
      throw new RangeError('ZIP method override is unsupported.')
    }
    if (override.deflateStrategy !== undefined && !DEFLATE_STRATEGIES.has(override.deflateStrategy)) {
      throw new RangeError('ZIP Deflate strategy override is unsupported.')
    }
    if (override.deflateStrategy !== undefined && override.method !== 'deflate' && override.method !== 'auto') {
      throw new RangeError('ZIP Deflate strategy can only be used with the Automatic or Deflate method.')
    }
    if (override.memLevel !== undefined && (
      !Number.isInteger(override.memLevel) ||
      override.memLevel < 1 ||
      override.memLevel > 9
    )) {
      throw new RangeError('ZIP memory level override must be between 1 and 9.')
    }
    if (override.memLevel !== undefined && override.method !== 'deflate' && override.method !== 'auto') {
      throw new RangeError('ZIP memory level can only be used with the Automatic or Deflate method.')
    }
    if (override.level !== undefined && (
      !Number.isInteger(override.level) ||
      override.level < 0 ||
      override.level > 9 ||
      (override.level === 0 && override.method !== 'auto')
    )) {
      throw new RangeError('ZIP compression level override must be between 1 and 9, or 0 for Automatic.')
    }
    if (override.level !== undefined && override.method === 'store') {
      throw new RangeError('ZIP compression level cannot be used with the Store method.')
    }

    const sourcePath = normalizedPath(override.sourcePath)
    if (!roots.some(rootPath => isSameOrChild(rootPath, sourcePath))) {
      throw new RangeError('ZIP method override must be inside a selected input.')
    }
  }
}

/**
 * Resolves the method for one source file. An exact file rule wins over every
 * directory rule; otherwise the nearest recursive ancestor wins. Ties are
 * settled by the later rule so an IPC payload can replace an earlier value.
 */
export function resolveZipMethod(
  sourcePath: string,
  defaultMethod: ZipOverrideMethod,
  overrides: readonly ZipMethodOverride[] | undefined
): ResolvedZipMethod {
  if (!overrides?.length) return { method: defaultMethod, explicit: false }

  const candidatePath = normalizedPath(sourcePath)
  const contenders: Array<{
    method: ZipOverrideMethod
    deflateStrategy?: DeflateStrategy
    memLevel?: number
    level?: number
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
      method: override.method,
      ...(override.deflateStrategy ? { deflateStrategy: override.deflateStrategy } : {}),
      ...(override.memLevel !== undefined ? { memLevel: override.memLevel } : {}),
      ...(override.level !== undefined ? { level: override.level } : {}),
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
  const winner = contenders[0]
  if (!winner) return { method: defaultMethod, explicit: false }

  // Strength, Deflate strategy, and memory level cascade independently. A
  // file can override its method while a containing folder supplies tuning.
  const level = winner.method === 'store'
    ? undefined
    : contenders.find(contender => contender.level !== undefined)?.level
  const deflateStrategy = winner.method === 'deflate' || winner.method === 'auto'
    ? contenders.find(contender => (
        (contender.method === 'deflate' || contender.method === 'auto') &&
        contender.deflateStrategy !== undefined
      ))?.deflateStrategy
    : undefined
  const memLevel = winner.method === 'deflate' || winner.method === 'auto'
    ? contenders.find(contender => (
        (contender.method === 'deflate' || contender.method === 'auto') &&
        contender.memLevel !== undefined
      ))?.memLevel
    : undefined
  return {
    method: winner.method,
    explicit: true,
    ...(deflateStrategy ? { deflateStrategy } : {}),
    ...(memLevel !== undefined ? { memLevel } : {}),
    ...(level !== undefined ? { level } : {})
  }
}
