import { promises as fsPromises } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { SplitDataWriter, ZipWriter, configure, type WritableWriter } from '@zip.js/zip.js'
import { NodeFileReader } from './zipFileReader'
import type { ProgressCallback } from './compressor'

// Also configured by zipFileReader, but a caller may pull in this module
// alone - without it zip.js tries to spawn a Blob-URL worker under Node.
configure({ useWebWorkers: false })

export const MIN_SPLIT_SIZE = 1024 * 1024
export const MAX_SPLIT_VOLUMES = 65535

export interface SplitZipOptions {
  source: { inputPaths: string[]; totalBytes: number }
  volumes: { outputPath: string; splitSize: number }
  squeeze: { level: number; password?: string }
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
}

interface VolumeSink extends WritableWriter {
  init(): Promise<void>
}

const isWindows = process.platform === 'win32'

function normalizeName(name: string): string {
  return isWindows ? name.toLowerCase() : name
}

/**
 * The last volume of a split set carries the `.zip` extension, the preceding
 * ones `.z01`, `.z02` and so on, all sharing this base.
 */
export function splitVolumeBase(outputPath: string): string {
  return outputPath.replace(/\.zip$/i, '')
}

function volumePathForDisk(basePath: string, diskNumber: number): string {
  return `${basePath}.z${String(diskNumber + 1).padStart(2, '0')}`
}

export function isSplitVolumeName(baseName: string, candidateName: string): boolean {
  const base = normalizeName(baseName)
  const candidate = normalizeName(candidateName)
  if (!candidate.startsWith(`${base}.`)) return false

  const suffix = candidate.slice(base.length + 1)
  return suffix === 'zip' || /^z\d{2,}$/.test(suffix)
}

export function createVolumePredicate(outputPath: string): (candidate: string) => boolean {
  const directory = path.resolve(path.dirname(outputPath))
  const baseName = path.basename(splitVolumeBase(outputPath))

  return (candidate) => {
    const resolved = path.resolve(candidate)
    if (normalizeName(path.dirname(resolved)) !== normalizeName(directory)) return false
    return isSplitVolumeName(baseName, path.basename(resolved))
  }
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
        lastModDate: stat.mtime
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
      lastModDate: stat.mtime
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
  const { level, password } = options.squeeze
  const { signal } = context

  const entries = await collectEntries(inputPaths, createVolumePredicate(outputPath))
  const { generator, volumePaths, openHandles } = createVolumeWriters(outputPath)
  const splitWriter = new SplitDataWriter(generator, splitSize)
  const zipWriter = new ZipWriter(splitWriter, {
    level,
    // ZipCrypto rather than AES for the same reason as the archiver path:
    // the app's own ZIP reader can decrypt it.
    ...(password ? { password, zipCrypto: true } : {})
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
          signal
        })
        continue
      }

      const reader = new NodeFileReader(entry.absolutePath)
      const entryStart = processedBytes
      try {
        // Entries are added one at a time on purpose: concurrent adds make
        // zip.js buffer each whole compressed entry in memory.
        await zipWriter.add(entry.entryName, reader, {
          level,
          lastModDate: entry.lastModDate,
          signal,
          onprogress: (progress) => report(entryStart + progress, entry.entryName)
        })
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
