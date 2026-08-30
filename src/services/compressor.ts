import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import archiver from 'archiver'
import zipEncrypted from 'archiver-zip-encrypted'
import zlib from 'zlib'
import {
  MAX_SPLIT_VOLUMES,
  MIN_SPLIT_SIZE,
  removeStaleVolumes,
  writeSplitZip,
  writeZipFile
} from './zip/splitWriter'
import { writeSevenZipArchive } from './sevenZip/writer'

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
export type ZipEncryptionMethod = 'zip20' | 'aes256' | 'aes128'
export type ZipMethod = 'deflate' | 'store'
export type DeflateStrategy = 'default' | 'filtered' | 'huffman_only' | 'rle' | 'fixed'
export type SevenZipMethod = 'lzma2' | 'copy'
export type MatchFinderWordSize = 32 | 64 | 128 | 273

export interface CompressionOptions {
  inputPaths: string[]
  outputPath: string
  format: ArchiveFormat
  level?: number // 0 (fastest/none) to 9 (maximum)
  password?: string
  encryptFileNames?: boolean // 7Z only, hides the file names as well
  splitSize?: number // maximum bytes per volume, ZIP and 7Z only
  // Expert options:
  encryptionMethod?: ZipEncryptionMethod
  zipMethod?: ZipMethod
  sevenZipMethod?: SevenZipMethod
  dictionarySize?: number
  matchFinderWordSize?: MatchFinderWordSize
  searchCycles?: number
  solidArchive?: boolean
  deflateStrategy?: DeflateStrategy
  memLevel?: number
}

export function mapDeflateStrategy(strategy?: DeflateStrategy): number | undefined {
  switch (strategy) {
    case 'filtered': return zlib.constants.Z_FILTERED
    case 'huffman_only': return zlib.constants.Z_HUFFMAN_ONLY
    case 'rle': return zlib.constants.Z_RLE
    case 'fixed': return zlib.constants.Z_FIXED
    case 'default': return zlib.constants.Z_DEFAULT_STRATEGY
    default: return undefined
  }
}

/** ZIP and 7Z are the formats whose containers define an encryption scheme. */
export function supportsPassword(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

/** Only 7Z can encrypt its header, which is what hides the file names. */
export function supportsHeaderEncryption(format: ArchiveFormat): boolean {
  return format === '7z'
}

export function supportsSplit(format: ArchiveFormat): boolean {
  return format === 'zip' || format === '7z'
}

// Deflate takes every step from store to maximum; 7-Zip's -mx scale only has
// six, so offering ten would leave half the slider doing nothing.
const DEFLATE_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const
const SEVEN_ZIP_LEVELS = [0, 1, 3, 5, 7, 9] as const

/** The levels a format's writer actually distinguishes, in slider order. */
export function compressionLevels(format: ArchiveFormat): readonly number[] {
  if (format === 'tar') return []
  return format === '7z' ? SEVEN_ZIP_LEVELS : DEFLATE_LEVELS
}

/** TAR only concatenates files, so a compression level would do nothing. */
export function supportsLevel(format: ArchiveFormat): boolean {
  return compressionLevels(format).length > 0
}

/** The nearest level a format supports, so switching formats keeps the intent. */
export function nearestLevel(level: number, format: ArchiveFormat): number {
  const levels = compressionLevels(format)
  if (levels.length === 0) return level
  return levels.reduce((best, candidate) =>
    Math.abs(candidate - level) < Math.abs(best - level) ? candidate : best
  )
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
    throw new Error('Password protection is currently available for ZIP and 7Z archives only.')
  }

  if (options.encryptFileNames && !supportsHeaderEncryption(format)) {
    throw new Error('Encrypting file names is currently available for 7Z archives only.')
  }

  if (options.encryptionMethod !== undefined && format !== 'zip') {
    throw new Error('ZIP encryption method can only be used with ZIP archives.')
  }
  if (options.encryptionMethod !== undefined && !['zip20', 'aes128', 'aes256'].includes(options.encryptionMethod)) {
    throw new RangeError('ZIP encryption method is unsupported.')
  }
  if (options.zipMethod !== undefined && format !== 'zip') {
    throw new Error('ZIP compression method can only be used with ZIP archives.')
  }
  if (options.zipMethod !== undefined && !['deflate', 'store'].includes(options.zipMethod)) {
    throw new RangeError('ZIP compression method is unsupported.')
  }
  if (
    format !== '7z' &&
    (options.sevenZipMethod !== undefined || options.dictionarySize !== undefined ||
      options.matchFinderWordSize !== undefined || options.searchCycles !== undefined ||
      options.solidArchive !== undefined)
  ) {
    throw new Error('7Z codec options can only be used with 7Z archives.')
  }
  if (
    !['zip', 'gz', 'tgz'].includes(format) &&
    (options.deflateStrategy !== undefined || options.memLevel !== undefined)
  ) {
    throw new Error('Deflate tuning options can only be used with ZIP, GZ, or TAR.GZ archives.')
  }
  if (options.sevenZipMethod !== undefined && !['lzma2', 'copy'].includes(options.sevenZipMethod)) {
    throw new RangeError('7Z compression method is unsupported.')
  }
  if (options.deflateStrategy !== undefined && !['default', 'filtered', 'huffman_only', 'rle', 'fixed'].includes(options.deflateStrategy)) {
    throw new RangeError('Deflate strategy is unsupported.')
  }
  if (options.memLevel !== undefined && (!Number.isInteger(options.memLevel) || options.memLevel < 1 || options.memLevel > 9)) {
    throw new RangeError('Deflate memory level must be between 1 and 9.')
  }
  if (options.dictionarySize !== undefined && (
    !Number.isInteger(options.dictionarySize) ||
    options.dictionarySize < 64 * 1024 ||
    options.dictionarySize > 128 * 1024 * 1024
  )) {
    throw new RangeError('7Z dictionary size must be between 64 KiB and 128 MiB.')
  }
  if (options.matchFinderWordSize !== undefined && ![32, 64, 128, 273].includes(options.matchFinderWordSize)) {
    throw new RangeError('7Z match finder word size is unsupported.')
  }
  if (options.searchCycles !== undefined && (
    !Number.isInteger(options.searchCycles) || options.searchCycles < 1 || options.searchCycles > 1024
  )) {
    throw new RangeError('7Z search cycles must be between 1 and 1024.')
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

  // 7z runs before the ZIP split branch below: Libera7z splits its byte stream
  // inline and numbers it even when the whole archive fits in one, so it has
  // no equivalent of that branch's single-volume special case.
  if (format === '7z') {
    const written = await writeSevenZipArchive(
      {
        inputPaths,
        outputPath,
        totalBytes,
        level,
        splitSize,
        password: options.password,
        encryptFileNames: options.encryptFileNames,
        dictionarySize: options.dictionarySize,
        method: options.sevenZipMethod,
        matchFinderWordSize: options.matchFinderWordSize,
        searchCycles: options.searchCycles,
        solid: options.solidArchive
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
          squeeze: {
            level,
            password: options.password,
            encryptionMethod: options.encryptionMethod,
            method: options.zipMethod
          }
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

  // archiver-zip-encrypted supports WinZip AES-256 but not AES-128. zip.js is
  // already used for split ZIPs and implements the standard AES strengths.
  if (format === 'zip' && options.password && options.encryptionMethod === 'aes128') {
    const written = await writeZipFile({
      source: { inputPaths, totalBytes },
      outputPath,
      squeeze: {
        level,
        password: options.password,
        encryptionMethod: 'aes128',
        method: options.zipMethod
      }
    }, onProgress, { signal })
    return {
      outputPath,
      originalSize: totalBytes,
      compressedSize: written.compressedSize,
      durationMs: Date.now() - startTime
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
      const strategy = mapDeflateStrategy(options.deflateStrategy)
      const archiveOptions: archiver.ArchiverOptions = {
        ...(format === 'zip' && options.zipMethod === 'store' ? { store: true } : {}),
        zlib: {
          level,
          ...(strategy !== undefined ? { strategy } : {}),
          ...(options.memLevel !== undefined ? { memLevel: options.memLevel } : {})
        }
      }

      if (options.password) {
        // ZipCrypto (zip20) remains the compatibility default. AES-128 uses
        // the zip.js path above because this plugin only supports AES-256.
        const method = options.encryptionMethod === 'aes256'
          ? 'aes256'
          : 'zip20'
        Object.assign(archiveOptions, {
          password: options.password,
          encryptionMethod: method
        })
      }

      if (format === 'tgz') {
        archiveOptions.gzip = true
        archiveOptions.gzipOptions = {
          level,
          ...(strategy !== undefined ? { strategy } : {}),
          ...(options.memLevel !== undefined ? { memLevel: options.memLevel } : {})
        }
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
      const strategy = mapDeflateStrategy(options.deflateStrategy)
      const gzip = zlib.createGzip({
        level,
        ...(strategy !== undefined ? { strategy } : {}),
        ...(options.memLevel !== undefined ? { memLevel: options.memLevel } : {})
      })
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
