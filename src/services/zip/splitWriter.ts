import { promises as fsPromises } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { SplitDataWriter, ZipWriter, configure, type WritableWriter } from '@zip.js/zip.js'
import { NodeFileReader } from './fileReader'
import {
  createVolumePredicate,
  isSplitVolumeName,
  normalizeName,
  splitVolumeBase,
  volumePathForDisk
} from './volumes'
import {
  registerZipCodecs,
  withZipDeflateOptions,
  ZipDeflateCompressionStream,
  ZIP_LZMA_METHOD,
  ZIP_ZSTD_METHOD
} from './codecs'
import {
  resolveZipMethod,
  type DeflateStrategy,
  type ZipMethod,
  type ZipMethodOverride
} from './methodOverrides'
import type { ProgressCallback, ZipEncryptionMethod } from '../compressor'

// Also configured by zipFileReader, but a caller may pull in this module
// alone - without it zip.js tries to spawn a Blob-URL worker under Node.
configure({
  useWebWorkers: false,
  CompressionStream: ZipDeflateCompressionStream as never,
  // zip.js disables the native CompressionStream route at levels other than
  // 6, so the fallback must be the same strategy-aware implementation.
  CompressionStreamFallback: ZipDeflateCompressionStream as never
})
registerZipCodecs()

export const MIN_SPLIT_SIZE = 1024 * 1024
export { MAX_SPLIT_VOLUMES } from './volumes'

export interface SplitZipOptions {
  source: { inputPaths: string[]; totalBytes: number }
  volumes: { outputPath: string; splitSize: number }
  squeeze: ZipSqueezeOptions
}

export interface ZipSqueezeOptions {
  level: number
  password?: string
  encryptionMethod?: ZipEncryptionMethod
  method?: ZipMethod
  methodOverrides?: ZipMethodOverride[]
  deflateStrategy?: DeflateStrategy
  memLevel?: number
}

export interface ZipFileOptions {
  source: { inputPaths: string[]; totalBytes: number }
  outputPath: string
  squeeze: ZipSqueezeOptions
}

export interface SplitZipResult {
  volumePaths: string[]
  compressedSize: number
}

interface ArchiveEntry {
  absolutePath: string
  entryName: string
  isDirectory: boolean
  size: number
  lastModDate: Date
  unixMode: number
}

interface VolumeSink extends WritableWriter {
  initialized?: boolean
  init(): Promise<void>
}

/**
 * The entry options that carry the chosen method. Store rides on level 0, the
 * two registered codecs name their method number, and Deflate is the default
 * zip.js already writes.
 */
function zipMethodOptions(squeeze: ZipSqueezeOptions, explicit = false): Record<string, unknown> {
  const level = squeeze.method === 'store' ? 0 : squeeze.level
  if (squeeze.method === 'lzma') return { level, compressionMethod: ZIP_LZMA_METHOD }
  if (squeeze.method === 'zstd') return { level, compressionMethod: ZIP_ZSTD_METHOD }
  if (squeeze.method === 'store') return STORE_ENTRY_OPTIONS
  if (explicit) return { level, compressionMethod: 8 }
  return { level }
}

/**
 * Store, spelled out for one entry. The method number has to be named because
 * the writer's own is whatever the archive asked for, and level 0 alone would
 * leave an LZMA or Zstandard entry on that codec.
 */
const STORE_ENTRY_OPTIONS = { level: 0, compressionMethod: 0 } as const

/**
 * The method this entry is written with: the archive's, unless a per-file rule
 * names another one for this path or a folder above it.
 */
function entryMethodOptions(
  squeeze: ZipSqueezeOptions,
  archiveOptions: Record<string, unknown>,
  entry: { absolutePath: string }
): { options: Record<string, unknown>; deflateStrategy?: DeflateStrategy; memLevel?: number } {
  const resolved = resolveZipMethod(entry.absolutePath, squeeze.method ?? 'deflate', squeeze.methodOverrides)
  // Deflate is the only method zlib tuning reaches; the rest ignore both.
  const deflateStrategy = resolved.method === 'deflate'
    ? resolved.deflateStrategy ?? squeeze.deflateStrategy
    : undefined
  const memLevel = resolved.method === 'deflate'
    ? resolved.memLevel ?? squeeze.memLevel
    : undefined
  const tuning = {
    ...(deflateStrategy ? { deflateStrategy } : {}),
    ...(memLevel !== undefined ? { memLevel } : {})
  }
  if (!resolved.explicit) return { options: archiveOptions, ...tuning }

  const level = resolved.method === 'store' ? 0 : resolved.level ?? Math.max(1, squeeze.level)
  return {
    options: zipMethodOptions({ ...squeeze, method: resolved.method, level }, true),
    ...tuning
  }
}

function zipEncryptionOptions(squeeze: ZipSqueezeOptions): Record<string, unknown> {
  if (!squeeze.password) return {}
  if (squeeze.encryptionMethod === 'aes128') {
    return { password: squeeze.password, encryptionStrength: 1 as const }
  }
  if (squeeze.encryptionMethod === 'aes256') {
    return { password: squeeze.password, encryptionStrength: 3 as const }
  }
  return { password: squeeze.password, zipCrypto: true }
}

/**
 * Removes volumes left behind by an earlier run. A shorter run would otherwise
 * leave the previous set's higher-numbered volumes next to the new ones, and
 * the mixed set reads as a corrupt archive.
 */
export async function removeStaleVolumes(outputPath: string): Promise<void> {
  const directory = path.dirname(outputPath)
  const baseName = path.basename(splitVolumeBase(outputPath))
  const names = await fsPromises.readdir(directory).catch(() => [] as string[])

  for (const name of names) {
    if (!isSplitVolumeName(baseName, name)) continue
    await fsPromises.unlink(path.join(directory, name)).catch(() => undefined)
  }
}

async function collectEntries(
  inputPaths: string[],
  isOwnVolume: (candidate: string) => boolean
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const visitedDirectories = new Set<string>()
  const usedRootNames = new Set<string>()

  // Archiver tolerated two inputs sharing a basename, zip.js rejects the
  // duplicate entry name outright, so the second root gets a suffix.
  const uniqueRootName = (name: string): string => {
    let candidate = name
    let suffix = 2
    while (usedRootNames.has(normalizeName(candidate))) {
      candidate = `${name} (${suffix})`
      suffix += 1
    }
    usedRootNames.add(normalizeName(candidate))
    return candidate
  }

  const walk = async (itemPath: string, entryName: string): Promise<void> => {
    if (isOwnVolume(itemPath)) return

    let stat
    try {
      stat = await fsPromises.lstat(itemPath)
    } catch (err) {
      console.error(`Error reading ${itemPath}:`, err)
      return
    }
    if (stat.isSymbolicLink()) return

    if (!stat.isDirectory()) {
      entries.push({
        absolutePath: itemPath,
        entryName,
        isDirectory: false,
        size: stat.size,
        lastModDate: stat.mtime,
        unixMode: stat.mode & 0xffff
      })
      return
    }

    const resolvedPath = await fsPromises.realpath(itemPath).catch(() => itemPath)
    if (visitedDirectories.has(resolvedPath)) return
    visitedDirectories.add(resolvedPath)

    entries.push({
      absolutePath: itemPath,
      entryName,
      isDirectory: true,
      size: 0,
      lastModDate: stat.mtime,
      unixMode: stat.mode & 0xffff
    })

    const children = await fsPromises.readdir(itemPath, { withFileTypes: true }).catch(() => [])
    for (const child of children) {
      await walk(path.join(itemPath, child.name), `${entryName}/${child.name}`)
    }
  }

  for (const itemPath of inputPaths) {
    if (isOwnVolume(itemPath)) continue
    await walk(itemPath, uniqueRootName(path.basename(itemPath)))
  }

  return entries
}

function createVolumeWriters(outputPath: string) {
  const basePath = splitVolumeBase(outputPath)
  const volumePaths: string[] = []
  const openHandles = new Set<FileHandle>()

  // SplitDataWriter pulls a sink only when it actually has bytes for the next
  // volume, so this generator never runs ahead of the disks on disk.
  const generator = (async function* (): AsyncGenerator<VolumeSink, boolean> {
    for (let diskNumber = 0; ; diskNumber += 1) {
      const volumePath = volumePathForDisk(basePath, diskNumber)
      let handle: FileHandle | null = null

      const releaseHandle = (): FileHandle | null => {
        const current = handle
        handle = null
        if (current) openHandles.delete(current)
        return current
      }

      yield {
        async init() {
          handle = await fsPromises.open(volumePath, 'w')
          openHandles.add(handle)
          volumePaths.push(volumePath)
        },
        writable: new WritableStream<Uint8Array>({
          async write(chunk) {
            if (!handle) throw new Error('Split volume is not initialized')
            await handle.write(chunk)
          },
          // zip.js closes each disk through this hook. The handle has to be
          // released here, not after close() resolves, or the rename of the
          // final volume races an open handle and fails with EPERM.
          async close() {
            await releaseHandle()?.close()
          },
          async abort() {
            await releaseHandle()?.close().catch(() => undefined)
          }
        })
      }
    }
  })()

  return { generator, volumePaths, openHandles }
}

function isSkippableEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { corruptedEntry?: boolean }).corruptedEntry) return false

  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}

/**
 * Writes a standard multi-volume ZIP: `base.z01`, `base.z02`, ... with the
 * final volume renamed to `base.zip` as the format requires. Entry offsets are
 * volume-relative, so the volumes cannot be concatenated back into one file -
 * they have to be read as a set.
 */
export async function writeSplitZip(
  options: SplitZipOptions,
  onProgress?: ProgressCallback,
  context: { signal?: AbortSignal } = {}
): Promise<SplitZipResult> {
  const { inputPaths, totalBytes } = options.source
  const { outputPath, splitSize } = options.volumes
  const methodOptions = zipMethodOptions(options.squeeze)
  const { signal } = context

  const entries = await collectEntries(inputPaths, createVolumePredicate(outputPath))
  const { generator, volumePaths, openHandles } = createVolumeWriters(outputPath)
  const splitWriter = new SplitDataWriter(generator, splitSize)
  const zipWriter = new ZipWriter(splitWriter, {
    ...methodOptions,
    ...zipEncryptionOptions(options.squeeze)
  })

  let processedBytes = 0
  const report = (bytes: number, currentFile?: string) => {
    if (!onProgress) return
    onProgress({
      processedBytes: bytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0,
      phase: 'processing',
      currentFile
    })
  }

  try {
    for (const entry of entries) {
      if (entry.isDirectory) {
        await zipWriter.add(entry.entryName, undefined, {
          directory: true,
          lastModDate: entry.lastModDate,
          unixMode: entry.unixMode,
          signal
        })
        continue
      }

      const reader = new NodeFileReader(entry.absolutePath)
      const entryStart = processedBytes
      try {
        const method = entryMethodOptions(options.squeeze, methodOptions, entry)
        // Entries are added one at a time on purpose: concurrent adds make
        // zip.js buffer each whole compressed entry in memory.
        await withZipDeflateOptions({ strategy: method.deflateStrategy, memLevel: method.memLevel }, () => zipWriter.add(entry.entryName, reader, {
          ...method.options,
          lastModDate: entry.lastModDate,
          unixMode: entry.unixMode,
          signal,
          onprogress: (progress) => report(entryStart + progress, entry.entryName)
        }))
        processedBytes = entryStart + entry.size
        report(processedBytes, entry.entryName)
      } catch (err) {
        if (!isSkippableEntryError(err)) throw err
        console.warn(`Skipping ${entry.absolutePath}:`, err)
        processedBytes = entryStart + entry.size
      } finally {
        await reader.close().catch(() => undefined)
      }
    }

    await zipWriter.close()
  } catch (err) {
    await splitWriter.writable.abort(err).catch(() => undefined)
    await Promise.all([...openHandles].map((handle) => handle.close().catch(() => undefined)))
    openHandles.clear()
    await Promise.all(volumePaths.map((volume) => fsPromises.unlink(volume).catch(() => undefined)))
    throw err
  }

  if (volumePaths.length === 0) {
    throw new Error('No split volume was written.')
  }

  const finalPath = `${splitVolumeBase(outputPath)}.zip`
  await fsPromises.rename(volumePaths[volumePaths.length - 1], finalPath)
  volumePaths[volumePaths.length - 1] = finalPath

  let compressedSize = 0
  for (const volume of volumePaths) {
    compressedSize += (await fsPromises.stat(volume)).size
  }

  return { volumePaths, compressedSize }
}

/** Writes a regular, non-split ZIP with zip.js. */
export async function writeZipFile(
  options: ZipFileOptions,
  onProgress?: ProgressCallback,
  context: { signal?: AbortSignal } = {}
): Promise<{ outputPath: string; compressedSize: number }> {
  const { inputPaths, totalBytes } = options.source
  const { outputPath, squeeze } = options
  const { signal } = context
  const entries = await collectEntries(inputPaths, candidate => path.resolve(candidate) === path.resolve(outputPath))
  let handle: FileHandle | null = null
  let processedBytes = 0

  const sink: VolumeSink = {
    initialized: false,
    async init() {
      if (handle) return
      handle = await fsPromises.open(outputPath, 'w')
      sink.initialized = true
    },
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        if (!handle) throw new Error('ZIP output is not initialized')
        await handle.write(chunk)
      },
      async close() {
        const current = handle
        handle = null
        await current?.close()
      },
      async abort() {
        const current = handle
        handle = null
        await current?.close().catch(() => undefined)
      }
    })
  }
  const methodOptions = zipMethodOptions(squeeze)
  const zipWriter = new ZipWriter(sink, {
    ...methodOptions,
    ...zipEncryptionOptions(squeeze)
  })
  const report = (bytes: number, currentFile?: string) => onProgress?.({
    processedBytes: bytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : 0,
    phase: 'processing',
    currentFile
  })

  try {
    for (const entry of entries) {
      if (entry.isDirectory) {
        await zipWriter.add(entry.entryName, undefined, {
          directory: true,
          lastModDate: entry.lastModDate,
          unixMode: entry.unixMode,
          signal
        })
        continue
      }
      const reader = new NodeFileReader(entry.absolutePath)
      const entryStart = processedBytes
      try {
        const method = entryMethodOptions(squeeze, methodOptions, entry)
        await withZipDeflateOptions({ strategy: method.deflateStrategy, memLevel: method.memLevel }, () => zipWriter.add(entry.entryName, reader, {
          ...method.options,
          lastModDate: entry.lastModDate,
          unixMode: entry.unixMode,
          signal,
          onprogress: progress => report(entryStart + progress, entry.entryName)
        }))
        processedBytes += entry.size
        report(processedBytes, entry.entryName)
      } catch (error) {
        if (!isSkippableEntryError(error)) throw error
        console.warn(`Skipping ${entry.absolutePath}:`, error)
        processedBytes = entryStart + entry.size
      } finally {
        await reader.close().catch(() => undefined)
      }
    }
    await zipWriter.close()
  } catch (error) {
    await sink.writable.abort(error).catch(() => undefined)
    await fsPromises.unlink(outputPath).catch(() => undefined)
    throw error
  }

  return { outputPath, compressedSize: (await fsPromises.stat(outputPath)).size }
}
