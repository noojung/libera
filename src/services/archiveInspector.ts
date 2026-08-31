import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'
import { ExtractionError, MAX_ARCHIVE_ENTRIES } from './extractor'
import { openZipArchive } from './zip/fileReader'
import { canonicalArchivePath, isZipFormatExtension, zipFormatLabel } from './archiveVolumes'
import type { ArchiveVolumeInfo } from './archiveInputResolver'
import { listSevenZipEntries } from './sevenZip/list'
import { discoverSevenZipVolumes, isSevenZipArchivePath } from './sevenZip/volumes'

export interface ArchiveEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  compressedSize?: number
  ratio?: number | null
  date?: string
  // Expert fields:
  codec?: string
  crc32?: string
  encrypted?: boolean
  encryptionMethod?: string
  mode?: number
  modeString?: string
  offset?: number
}

export interface ArchiveHeaderInfo {
  signature?: string
  formatVersion?: string
  codecSummary?: string
  encryptionAlgorithm?: string
  solid?: boolean
  centralDirectoryOffset?: number
  centralDirectorySize?: number
  nextHeaderOffset?: number
  nextHeaderSize?: number
}

export interface ArchiveInspectionResult {
  archivePath: string
  format: string
  volumeCount?: number
  volumes?: ArchiveVolumeInfo[]
  passwordProtected: boolean
  totalFiles: number
  totalUncompressedSize: number | null
  totalCompressedSize: number
  overallRatio: number | null
  entries: ArchiveEntry[]
  headerInfo?: ArchiveHeaderInfo
}

export function formatUnixMode(mode?: number, isDirectory?: boolean): string | undefined {
  if (mode === undefined) return undefined
  const isDir = isDirectory || ((mode & 0o170000) === 0o040000)
  const isLink = (mode & 0o170000) === 0o120000
  const typeChar = isLink ? 'l' : isDir ? 'd' : '-'
  const rwx = (p: number) => `${(p & 4) ? 'r' : '-'}${(p & 2) ? 'w' : '-'}${(p & 1) ? 'x' : '-'}`
  return `${typeChar}${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`
}

function tooManyEntriesError(): ExtractionError {
  return new ExtractionError(
    'TOO_MANY_ENTRIES',
    `Unsafe archive: archive contains more than ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries`
  )
}

function getZipCodecName(method?: number): string {
  if (method === 0) return 'Store'
  if (method === 8) return 'Deflate'
  if (method === 9) return 'Deflate64'
  if (method === 12) return 'BZip2'
  if (method === 14) return 'LZMA'
  if (method === 93) return 'Zstd'
  if (method === 98) return 'PPMd'
  return method !== undefined ? `Method ${method}` : 'Deflate'
}

function getZipEncryptionName(entry: {
  encrypted: boolean
  zipCrypto: boolean
  extraFieldAES?: { strength?: number }
}): string {
  if (!entry.encrypted) return 'None'
  if (entry.zipCrypto) return 'ZipCrypto'
  if (entry.extraFieldAES?.strength === 1) return 'AES-128'
  if (entry.extraFieldAES?.strength === 2) return 'AES-192'
  if (entry.extraFieldAES?.strength === 3) return 'AES-256'
  return 'AES'
}

function uniqueSummary(values: Array<string | undefined>, fallback: string): string {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))]
  return unique.length ? unique.join(', ') : fallback
}

function formatDictionarySize(size?: number): string {
  if (size === undefined) return ''
  if (size >= 1024 * 1024 && size % (1024 * 1024) === 0) return ` [${size / (1024 * 1024)} MB]`
  if (size >= 1024 && size % 1024 === 0) return ` [${size / 1024} KB]`
  return ` [${size} B]`
}

function calculateOverallSavings(totalCompressedSize: number, totalUncompressedSize: number): number {
  return Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 1000) / 10
}

function formatSignature(bytes: Uint8Array, label: string): string {
  return `${Array.from(bytes, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')} (${label})`
}

async function readFileBytes(filePath: string, position: number, length: number): Promise<Uint8Array> {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readZipHeaderInfo(
  volumePaths: readonly string[],
  volumeSizes: readonly number[],
  isSplit: boolean
): Promise<Pick<ArchiveHeaderInfo, 'signature' | 'centralDirectoryOffset' | 'centralDirectorySize'>> {
  const firstBytes = await readFileBytes(volumePaths[0], 0, 4)
  const terminalPath = volumePaths.at(-1)!
  const terminalSize = volumeSizes.at(-1)!
  const tailLength = Math.min(terminalSize, 65_557)
  const tail = await readFileBytes(terminalPath, terminalSize - tailLength, tailLength)
  let eocdOffset = -1
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail[index] === 0x50 && tail[index + 1] === 0x4b && tail[index + 2] === 0x05 && tail[index + 3] === 0x06) {
      eocdOffset = index
      break
    }
  }
  const view = eocdOffset >= 0
    ? new DataView(tail.buffer, tail.byteOffset + eocdOffset, tail.length - eocdOffset)
    : undefined
  const centralDirectorySize = view?.getUint32(12, true)
  const centralDirectoryOffset = view?.getUint32(16, true)
  return {
    signature: formatSignature(firstBytes, isSplit ? 'Split ZIP' : 'ZIP'),
    centralDirectorySize: centralDirectorySize === 0xffffffff ? undefined : centralDirectorySize,
    centralDirectoryOffset: centralDirectoryOffset === 0xffffffff ? undefined : centralDirectoryOffset
  }
}

async function inspectTarArchive(
  archivePath: string,
  totalCompressedSize: number,
  format: 'TAR' | 'TAR.GZ'
): Promise<ArchiveInspectionResult> {
  const tarMagic = format === 'TAR' ? await readFileBytes(archivePath, 257, 8) : undefined
  const hasUstarMagic = tarMagic !== undefined && Buffer.from(tarMagic.subarray(0, 5)).toString('ascii') === 'ustar'
  const entries: ArchiveEntry[] = []
  let totalUncompressedSize = 0
  let limitError: ExtractionError | null = null
  const listingReference: { current?: { destroy(error?: Error): void } } = {}
  const listing = tar.t({
    strict: true,
    onentry: (entry: any) => {
      const size = Number(entry.size || 0)
      const isDir = entry.type === 'Directory'
      entries.push({
        id: `entry-${entries.length}`,
        name: path.basename(entry.path),
        path: entry.path,
        isDirectory: isDir,
        size,
        date: entry.mtime ? new Date(entry.mtime).toLocaleDateString() : undefined,
        codec: format === 'TAR' ? 'None (Store)' : 'Gzip (Deflate)',
        encrypted: false,
        encryptionMethod: 'None',
        mode: entry.mode,
        modeString: formatUnixMode(entry.mode, isDir)
      })
      totalUncompressedSize += size
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        limitError = tooManyEntriesError()
        listingReference.current?.destroy(limitError)
      }
    }
  })
  listingReference.current = listing as unknown as { destroy(error?: Error): void }

  try {
    await pipeline(fs.createReadStream(archivePath), listing)
  } catch (error) {
    if (limitError) throw limitError
    throw error
  }

  return {
    archivePath,
    format,
    passwordProtected: false,
    totalFiles: entries.filter(entry => !entry.isDirectory).length,
    totalUncompressedSize,
    totalCompressedSize,
    overallRatio: totalUncompressedSize > 0
      ? calculateOverallSavings(totalCompressedSize, totalUncompressedSize)
      : 0,
    entries,
    headerInfo: {
      signature: format === 'TAR'
        ? hasUstarMagic ? formatSignature(tarMagic.subarray(0, 6), 'ustar') : 'TAR (legacy header)'
        : '1F 8B (GZIP)',
      codecSummary: format === 'TAR' ? 'POSIX Tarball' : 'Gzip / Deflate Stream',
      encryptionAlgorithm: 'None',
      formatVersion: format === 'TAR' ? hasUstarMagic ? 'POSIX ustar' : 'V7 / legacy TAR' : 'RFC 1952',
      solid: false
    }
  }
}

export interface ArchiveInspectionOptions {
  password?: string
}

export async function inspectArchive(
  inputPath: string,
  options: ArchiveInspectionOptions = {}
): Promise<ArchiveInspectionResult> {
  // Any volume identifies the set, but only one end of it can be opened, and
  // which end that is depends on the format.
  const archivePath = canonicalArchivePath(inputPath)
  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()
  const stat = await fsPromises.stat(archivePath).catch(() => null)
  if (!stat) throw new Error(`File does not exist: ${archivePath}`)
  if (!stat.isFile()) throw new Error('Archive inspection requires a file')
  let totalCompressedSize = stat.size

  if (isZipFormatExtension(ext)) {
    const zip = await openZipArchive(archivePath, MAX_ARCHIVE_ENTRIES)
    try {
      // A split set's size is the whole set, not just the volume opened.
      totalCompressedSize = zip.totalBytes
      if (zip.entries.length > MAX_ARCHIVE_ENTRIES) throw tooManyEntriesError()
      let totalUncompressedSize = 0
      const zipHeaderInfo = await readZipHeaderInfo(zip.volumePaths, zip.volumeSizes, zip.isSplit)
      const entries: ArchiveEntry[] = zip.entries.map((entry, index) => {
        const size = entry.directory ? 0 : Number(entry.uncompressedSize)
        const compressedSize = entry.directory ? 0 : Number(entry.compressedSize)
        totalUncompressedSize += size
        const crc32 = entry.crc32 !== undefined
          ? '0x' + (entry.crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0')
          : undefined
        const unixMode = entry.unixMode

        return {
          id: `entry-${index}`,
          name: path.basename(entry.filename) || entry.filename,
          path: entry.filename,
          isDirectory: entry.directory,
          size,
          compressedSize,
          ratio: size > 0 ? Math.round((1 - (compressedSize / size)) * 100) : 0,
          date: entry.lastModDate ? entry.lastModDate.toLocaleDateString() : undefined,
          codec: getZipCodecName(entry.compressionMethod),
          encrypted: entry.encrypted,
          encryptionMethod: getZipEncryptionName(entry),
          crc32,
          mode: unixMode,
          modeString: formatUnixMode(unixMode, entry.directory),
          offset: entry.offset
        }
      })

      return {
        archivePath,
        format: zipFormatLabel(ext),
        volumeCount: zip.volumePaths.length,
        ...(zip.volumePaths.length > 1
          ? {
              volumes: zip.volumePaths.map((volumePath, index) => ({
                path: volumePath,
                name: path.basename(volumePath) || volumePath,
                size: zip.volumeSizes[index]
              }))
            }
          : {}),
        passwordProtected: zip.entries.some(entry => entry.encrypted),
        totalFiles: entries.filter(entry => !entry.isDirectory).length,
        totalUncompressedSize,
        totalCompressedSize,
        overallRatio: totalUncompressedSize > 0
          ? calculateOverallSavings(totalCompressedSize, totalUncompressedSize)
          : 0,
        entries,
        headerInfo: {
          ...zipHeaderInfo,
          formatVersion: uniqueSummary(zip.entries.map(entry => `${Math.floor(entry.version / 10)}.${entry.version % 10}`), '2.0'),
          codecSummary: uniqueSummary(entries.map(entry => entry.codec), 'Store'),
          encryptionAlgorithm: uniqueSummary(entries.filter(entry => entry.encrypted).map(entry => entry.encryptionMethod), 'None'),
          solid: false
        }
      }
    } finally {
      await zip.close()
    }
  }

  if (isSevenZipArchivePath(archivePath)) {
    const listing = await listSevenZipEntries(archivePath, {
      password: options.password,
      maxEntries: MAX_ARCHIVE_ENTRIES
    })

    let totalUncompressedSize = 0
    const entries: ArchiveEntry[] = listing.entries.map((entry, index) => {
      const size = entry.isDirectory ? 0 : entry.size
      const compressedSize = entry.solid ? undefined : entry.packedSize
      totalUncompressedSize += size
      return {
        id: `entry-${index}`,
        name: path.basename(entry.path) || entry.path,
        path: entry.path,
        isDirectory: entry.isDirectory,
        size,
        // A solid block has one shared packed size, not one size per file.
        // Attaching that block size to its first entry makes the row wildly
        // misleading, so only expose per-entry values for non-solid folders.
        compressedSize,
        ratio: compressedSize === undefined
          ? null
          : size > 0
            ? Math.round((1 - (compressedSize / size)) * 100)
            : 0,
        date: entry.modified,
        codec: `${entry.codec ?? 'Copy'}${formatDictionarySize(entry.dictionarySize)}`,
        encrypted: entry.encrypted,
        encryptionMethod: entry.encrypted ? 'AES-256 (SHA-256 KDF)' : 'None',
        crc32: entry.crc ? `0x${entry.crc}` : undefined,
        mode: entry.mode,
        modeString: formatUnixMode(entry.mode, entry.isDirectory)
      }
    })

    // A split set's compressed size is the whole set, not the first volume.
    let volumes: ArchiveVolumeInfo[] | undefined
    if (listing.volumeCount > 1) {
      const volumePaths = await discoverSevenZipVolumes(archivePath)
      volumes = await Promise.all(volumePaths.map(async volumePath => ({
        path: volumePath,
        name: path.basename(volumePath) || volumePath,
        size: (await fsPromises.stat(volumePath)).size
      })))
      totalCompressedSize = volumes.reduce((total, volume) => total + volume.size, 0)
    }

    return {
      archivePath,
      format: '7Z',
      volumeCount: listing.volumeCount > 1 ? listing.volumeCount : undefined,
      volumes,
      passwordProtected: listing.anyEncrypted,
      totalFiles: entries.filter(entry => !entry.isDirectory).length,
      totalUncompressedSize,
      totalCompressedSize,
      overallRatio: totalUncompressedSize > 0
        ? calculateOverallSavings(totalCompressedSize, totalUncompressedSize)
        : 0,
      entries,
      headerInfo: {
        signature: '37 7A BC AF 27 1C (7-Zip)',
        formatVersion: listing.formatVersion,
        codecSummary: uniqueSummary(entries.map(entry => entry.codec), 'Copy'),
        encryptionAlgorithm: listing.anyEncrypted ? 'AES-256 (SHA-256)' : 'None',
        solid: listing.anySolid,
        nextHeaderOffset: listing.nextHeaderOffset,
        nextHeaderSize: listing.nextHeaderSize
      }
    }
  }

  if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
    return inspectTarArchive(
      archivePath,
      totalCompressedSize,
      fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz') ? 'TAR.GZ' : 'TAR'
    )
  }

  if (ext === '.gz') {
    const baseName = path.basename(archivePath, '.gz')
    return {
      archivePath,
      format: 'GZ',
      passwordProtected: false,
      totalFiles: 1,
      totalUncompressedSize: null,
      totalCompressedSize,
      overallRatio: null,
      entries: [
        {
          id: 'entry-0',
          name: baseName,
          path: baseName,
          isDirectory: false,
          size: null,
          compressedSize: totalCompressedSize,
          ratio: null,
          codec: 'Deflate (Gzip)',
          encrypted: false,
          encryptionMethod: 'None'
        }
      ],
      headerInfo: {
        signature: '1F 8B (GZIP)',
        formatVersion: 'RFC 1952',
        codecSummary: 'Deflate / Gzip Stream',
        encryptionAlgorithm: 'None',
        solid: false
      }
    }
  }

  throw new Error(`Unsupported archive format: ${ext}`)
}
