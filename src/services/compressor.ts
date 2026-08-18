import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import archiver from 'archiver'
import zipEncrypted from 'archiver-zip-encrypted'
import zlib from 'zlib'
import {
  MAX_SPLIT_VOLUMES,
  MIN_SPLIT_SIZE,
  removeStaleVolumes,
  writeSplitZip
} from './splitZipWriter'
import { writeSevenZipArchive } from './sevenZipWriter'

/** A split set's compressed size is the whole set, not the volume opened. */
async function totalOutputSize(outputPaths: string[]): Promise<number> {
  const sizes = await Promise.all(
    outputPaths.map(outputPath => fsPromises.stat(outputPath).then(stat => stat.size, () => 0))
  )
  return sizes.reduce((total, size) => total + size, 0)
}

// Archiver does not provide password protection for ZIP archives itself.
// This plugin adds the ZipCrypto format used below. It is registered once when
// this module is loaded; registering it per job would throw in later jobs.
archiver.registerFormat('zip-encrypted', zipEncrypted)

export type ArchiveFormat = 'zip' | 'tar' | 'gz' | 'tgz' | '7z'

export interface CompressionOptions {
  inputPaths: string[]
  outputPath: string
  format: ArchiveFormat
  level?: number // 0 (fastest/none) to 9 (maximum)
  password?: string
  splitSize?: number // maximum bytes per volume, ZIP and 7Z only
}

/** Only ZIP archives can be created with a password. */
export function supportsPassword(format: ArchiveFormat): boolean {
  return format === 'zip'
}

export function supportsSplit(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

export interface ProgressData {
  processedBytes: number
  totalBytes: number | null
  percent: number | null
  phase: 'processing' | 'complete'
  currentFile?: string
}

export type ProgressCallback = (data: ProgressData) => void

export type CompressionErrorCode =
  | 'COMPRESSION_CANCELLED'
  | 'SPLIT_SIZE_TOO_SMALL'
  | 'SPLIT_NOT_SUPPORTED_FOR_FORMAT'
  | 'SPLIT_TOO_MANY_VOLUMES'

export class CompressionError extends Error {
  constructor(public readonly code: CompressionErrorCode, message: string) {
    super(message)
    this.name = 'CompressionError'
  }
}

export interface CompressionContext {
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CompressionError('COMPRESSION_CANCELLED', 'Compression cancelled')
}

/**
 * Calculates total size of files/directories recursively without following
 * symbolic links. This keeps directory scans non-blocking and prevents
 * symlink cycles from being traversed.
 *
 * `excludePath` omits a single absolute path from the total. It is used to
 * leave the archive being written out of its own size estimate so the
 * reported progress percentage stays accurate.
 */
export async function calculateTotalSize(paths: string[], excludePath?: string): Promise<number> {
  const visitedDirectories = new Set<string>()
  const excluded = excludePath ? path.resolve(excludePath) : null

  const calculatePathSize = async (itemPath: string): Promise<number> => {
    try {
      if (excluded && path.resolve(itemPath) === excluded) return 0

      const stat = await fsPromises.lstat(itemPath)
      if (stat.isSymbolicLink()) return 0

      if (!stat.isDirectory()) return stat.size

      const resolvedPath = await fsPromises.realpath(itemPath)
      if (visitedDirectories.has(resolvedPath)) return 0
      visitedDirectories.add(resolvedPath)

      const entries = await fsPromises.readdir(itemPath, { withFileTypes: true })
      let total = 0
      for (const entry of entries) {
        total += await calculatePathSize(path.join(itemPath, entry.name))
      }
      return total
    } catch {
      // Ignore unreadable files and directories.
      return 0
    }
  }

  let total = 0
  for (const itemPath of paths) {
    total += await calculatePathSize(itemPath)
  }
  return total
}

export async function compressArchive(
  options: CompressionOptions,
  onProgress?: ProgressCallback,
  context: CompressionContext = {}
): Promise<{
  outputPath: string
  originalSize: number
  compressedSize: number
  durationMs: number
  volumePaths?: string[]
}> {
  const startTime = Date.now()
  const { inputPaths, outputPath, format, level = 6, splitSize } = options
  const { signal } = context

  if (options.password && !supportsPassword(format)) {
    throw new Error('Password protection is currently available for ZIP archives only.')
  }

  if (splitSize !== undefined) {
    if (!supportsSplit(format)) {
      throw new CompressionError(
        'SPLIT_NOT_SUPPORTED_FOR_FORMAT',
        'Split archives are currently available for ZIP and 7Z archives only.'
      )
    }
    if (!Number.isFinite(splitSize) || splitSize < MIN_SPLIT_SIZE) {
      throw new CompressionError('SPLIT_SIZE_TOO_SMALL', 'The split size is below the supported minimum.')
    }
  }

  throwIfAborted(signal)

  const outputDir = path.dirname(outputPath)
  await fsPromises.mkdir(outputDir, { recursive: true })

  // Runs before the size scan so last run's volumes are neither counted nor
  // swept into the archive by the directory walk below.
  if (splitSize !== undefined) {
    await removeStaleVolumes(outputPath)
  }

  // The archive frequently lands inside a folder that is itself being
  // compressed - the default save location is the downloads folder, so
  // archiving downloads writes downloads/archive.zip. Left alone, the
  // directory walk picks that file up and streams it into the archive while
  // it is still being written, so the read never reaches EOF and the whole
  // job stalls with the progress bar frozen. Skip it everywhere it could be
  // picked up.
  const resolvedOutputPath = path.resolve(outputPath)

  const totalBytes = await calculateTotalSize(inputPaths, resolvedOutputPath)

  throwIfAborted(signal)

  // 7z runs before the ZIP split branch below: 7-Zip handles volumes itself,
  // through a switch, and numbers them even when the whole archive fits in
  // one - so it has no equivalent of that branch's single-volume special case.
  if (format === '7z') {
    const written = await writeSevenZipArchive(
      {
        inputPaths,
        outputPath,
        totalBytes,
        level,
        splitSize
      },
      onProgress,
      { signal }
    )

    const compressedSize = await totalOutputSize(written.volumePaths ?? [written.outputPath])
    return {
      outputPath: written.outputPath,
      originalSize: totalBytes,
      compressedSize,
      durationMs: Date.now() - startTime,
      ...(written.volumePaths ? { volumePaths: written.volumePaths } : {})
    }
  }

  // A single-volume split archive is not an ordinary ZIP: zip.js prefixes the
  // first volume with a 4 byte split signature, which strict readers - this
  // app's included - reject as prepended data. Anything that fits in one
  // volume therefore takes the regular path below instead.
  if (splitSize !== undefined && totalBytes > splitSize) {
    if (Math.ceil(totalBytes / splitSize) + 1 > MAX_SPLIT_VOLUMES) {
      throw new CompressionError('SPLIT_TOO_MANY_VOLUMES', 'The split size produces too many volumes.')
    }

    let split
    try {
      split = await writeSplitZip(
        {
          source: { inputPaths, totalBytes },
          volumes: { outputPath, splitSize },
          squeeze: { level, password: options.password }
        },
        onProgress,
        { signal }
      )
    } catch (err) {
      if (signal?.aborted) throw new CompressionError('COMPRESSION_CANCELLED', 'Compression cancelled')
      throw err
    }

    if (onProgress) {
      onProgress({
        processedBytes: totalBytes,
        totalBytes,
        percent: 100,
        phase: 'complete'
      })
    }

    return {
      outputPath: split.volumePaths[split.volumePaths.length - 1],
      originalSize: totalBytes,
      compressedSize: split.compressedSize,
      durationMs: Date.now() - startTime,
      volumePaths: split.volumePaths
    }
  }

  if (format === 'zip' || format === 'tar' || format === 'tgz') {
    const archiveInputs: { itemPath: string; isDirectory: boolean }[] = []
    for (const itemPath of inputPaths) {
      if (path.resolve(itemPath) === resolvedOutputPath) continue
      try {
        const stat = await fsPromises.lstat(itemPath)
        archiveInputs.push({ itemPath, isDirectory: stat.isDirectory() })
      } catch (err) {
        console.error(`Error reading ${itemPath}:`, err)
      }
    }

    throwIfAborted(signal)

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath)

      const archiverFormat = format === 'tgz'
        ? 'tar'
        : format === 'zip' && options.password
          ? 'zip-encrypted'
          : format
      const archiveOptions: archiver.ArchiverOptions = {
        zlib: { level }
      }

      if (options.password) {
        // ZipCrypto is intentionally used instead of AES so the archive can
        // also be extracted by the app's current ZIP reader.
        // The UI explains that this is for compatibility, not strong secrecy.
        Object.assign(archiveOptions, {
          password: options.password,
          encryptionMethod: 'zip20'
        })
      }

      if (format === 'tgz') {
        archiveOptions.gzip = true
        archiveOptions.gzipOptions = { level }
      }

      const archive = archiver(archiverFormat as archiver.Format, archiveOptions)

      let processedBytes = 0
      let settled = false
      let cancelled = false

      const onAbort = () => {
        if (settled || cancelled) return
        cancelled = true
        // Unpipe before aborting/ending so archiver's in-flight append cannot
        // write to `output` after it starts closing - writing post-close
        // throws ERR_STREAM_DESTROYED as an uncaught exception since archiver
        // owns that write, not this promise.
        archive.unpipe(output)
        archive.abort()
        output.end()
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      output.on('error', (err) => {
        if (settled || cancelled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })

      archive.on('warning', (err) => {
        if (settled || cancelled) return
        if (err.code === 'ENOENT') {
          console.warn('Archiver warning:', err)
        } else {
          settled = true
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        }
      })

      archive.on('error', (err) => {
        if (settled || cancelled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      })

      archive.on('entry', (entry) => {
        processedBytes += entry.stats?.size || 0
        if (onProgress) {
          const percent = totalBytes > 0 ? Math.min(100, Math.round((processedBytes / totalBytes) * 100)) : 0
          onProgress({
            processedBytes,
            totalBytes,
            percent,
            phase: 'processing',
            currentFile: entry.name
          })
        }
      })

      archive.pipe(output)

      for (const { itemPath, isDirectory } of archiveInputs) {
        const baseName = path.basename(itemPath)
        if (isDirectory) {
          // Returning false from this callback drops the entry from the walk.
          // entry.name is relative to itemPath, so resolving the two gives the
          // absolute path to compare against the archive's own location.
          archive.directory(itemPath, baseName, entry =>
            path.resolve(itemPath, entry.name) === resolvedOutputPath ? false : entry
          )
        } else {
          archive.file(itemPath, { name: baseName })
        }
      }

      output.on('close', async () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (cancelled) {
          await fsPromises.unlink(outputPath).catch(() => {})
          reject(new CompressionError('COMPRESSION_CANCELLED', 'Compression cancelled'))
          return
        }
        try {
          const compressedSize = (await fsPromises.stat(outputPath)).size
          const durationMs = Date.now() - startTime
          if (onProgress) {
            onProgress({
              processedBytes: totalBytes,
              totalBytes,
              percent: 100,
              phase: 'complete'
            })
          }
          resolve({
            outputPath,
            originalSize: totalBytes,
            compressedSize,
            durationMs
          })
        } catch (err) {
          reject(err)
        }
      })

      archive.finalize()
    })
  } else if (format === 'gz') {
    if (inputPaths.length === 0) {
      throw new Error('No input files specified for GZ compression.')
    }

    const sourceFile = inputPaths[0]
    const inputStat = await fsPromises.lstat(sourceFile)
    if (inputStat.isDirectory()) {
      throw new Error('GZ format supports single files only. Please use .tgz or .zip for folder compression.')
    }

    throwIfAborted(signal)

    return new Promise((resolve, reject) => {
      const gzip = zlib.createGzip({ level })
      const readStream = fs.createReadStream(sourceFile)
      const writeStream = fs.createWriteStream(outputPath)

      let settled = false
      let cancelled = false

      const onAbort = () => {
        if (settled || cancelled) return
        cancelled = true
        // Unpipe before ending `writeStream` so a chunk already in flight from
        // `readStream`/`gzip` cannot write to it after it starts closing -
        // writing post-close throws ERR_STREAM_DESTROYED as an uncaught
        // exception since the pipe owns that write, not this promise.
        readStream.unpipe(gzip)
        gzip.unpipe(writeStream)
        readStream.destroy()
        gzip.destroy()
        writeStream.end()
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      let processed = 0
      readStream.on('data', (chunk) => {
        processed += chunk.length
        if (onProgress) {
          onProgress({
            processedBytes: processed,
            totalBytes: inputStat.size,
            percent: Math.min(100, Math.round((processed / inputStat.size) * 100)),
            phase: 'processing',
            currentFile: path.basename(sourceFile)
          })
        }
      })

      readStream.pipe(gzip).pipe(writeStream)

      writeStream.on('finish', async () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (cancelled) {
          await fsPromises.unlink(outputPath).catch(() => {})
          reject(new CompressionError('COMPRESSION_CANCELLED', 'Compression cancelled'))
          return
        }
        try {
          const compressedSize = (await fsPromises.stat(outputPath)).size
          const durationMs = Date.now() - startTime
          resolve({
            outputPath,
            originalSize: inputStat.size,
            compressedSize,
            durationMs
          })
        } catch (err) {
          reject(err)
        }
      })

      const onError = (err: Error) => {
        if (settled || cancelled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
      writeStream.on('error', onError)
      readStream.on('error', onError)
      gzip.on('error', onError)
    })
  } else {
    throw new Error(`Unsupported format: ${format}`)
  }
}
