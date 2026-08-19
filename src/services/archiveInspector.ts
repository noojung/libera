import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'
import { ExtractionError, MAX_ARCHIVE_ENTRIES } from './extractor'
import { openZipArchive } from './zipFileReader'
import { canonicalArchivePath, isZipFormatExtension, zipFormatLabel } from './archiveVolumes'
import { listSevenZipEntries } from './sevenZipList'
import { discoverSevenZipVolumes, isSevenZipArchivePath } from './sevenZipVolumes'

export interface ArchiveEntry {
  id: string
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  compressedSize?: number
  ratio?: number | null
  date?: string
}

export interface ArchiveInspectionResult {
  archivePath: string
  format: string
  volumeCount?: number
  passwordProtected: boolean
  totalFiles: number
  totalUncompressedSize: number | null
  totalCompressedSize: number
  overallRatio: number | null
  entries: ArchiveEntry[]
}

function tooManyEntriesError(): ExtractionError {
  return new ExtractionError(
    'TOO_MANY_ENTRIES',
    `Unsafe archive: archive contains more than ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries`
  )
}

async function inspectTarArchive(
  archivePath: string,
  totalCompressedSize: number,
  format: 'TAR' | 'TAR.GZ'
): Promise<ArchiveInspectionResult> {
  const entries: ArchiveEntry[] = []
  let totalUncompressedSize = 0
  let limitError: ExtractionError | null = null
  const listingReference: { current?: { destroy(error?: Error): void } } = {}
  const listing = tar.t({
    strict: true,
    onentry: (entry: any) => {
      const size = Number(entry.size || 0)
      entries.push({
        id: `entry-${entries.length}`,
        name: path.basename(entry.path),
        path: entry.path,
        isDirectory: entry.type === 'Directory',
        size,
        date: entry.mtime ? new Date(entry.mtime).toLocaleDateString() : undefined
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
      ? Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 100)
      : 0,
    entries
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
      const entries: ArchiveEntry[] = zip.entries.map((entry, index) => {
        const size = entry.directory ? 0 : Number(entry.uncompressedSize)
        const compressedSize = entry.directory ? 0 : Number(entry.compressedSize)
        totalUncompressedSize += size
        return {
          id: `entry-${index}`,
          name: path.basename(entry.filename) || entry.filename,
          path: entry.filename,
          isDirectory: entry.directory,
          size,
          compressedSize,
          ratio: size > 0 ? Math.round((1 - (compressedSize / size)) * 100) : 0,
          date: entry.lastModDate ? entry.lastModDate.toLocaleDateString() : undefined
        }
      })

      return {
        archivePath,
        format: zipFormatLabel(ext),
        volumeCount: zip.volumePaths.length,
        passwordProtected: zip.entries.some(entry => entry.encrypted),
        totalFiles: entries.filter(entry => !entry.isDirectory).length,
        totalUncompressedSize,
        totalCompressedSize,
        overallRatio: totalUncompressedSize > 0
          ? Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 100)
          : 0,
        entries
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
      totalUncompressedSize += size
      return {
        id: `entry-${index}`,
        name: path.basename(entry.path) || entry.path,
        path: entry.path,
        isDirectory: entry.isDirectory,
        size,
        // 7-Zip only reports a packed size for the entry that starts a solid
        // block, so a per-entry ratio would be meaningless for the rest.
        compressedSize: undefined,
        ratio: null,
        date: entry.modified
      }
    })

    // A split set's compressed size is the whole set, not the first volume.
    if (listing.volumeCount > 1) {
      const volumes = await discoverSevenZipVolumes(archivePath).catch(() => null)
      if (volumes) {
        const sizes = await Promise.all(volumes.map(volume => fsPromises.stat(volume).then(one => one.size, () => 0)))
        totalCompressedSize = sizes.reduce((total, size) => total + size, 0)
      }
    }

    return {
      archivePath,
      format: '7Z',
      volumeCount: listing.volumeCount > 1 ? listing.volumeCount : undefined,
      passwordProtected: listing.anyEncrypted,
      totalFiles: entries.filter(entry => !entry.isDirectory).length,
      totalUncompressedSize,
      totalCompressedSize,
      overallRatio: totalUncompressedSize > 0
        ? Math.round((1 - (totalCompressedSize / totalUncompressedSize)) * 100)
        : 0,
      entries
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
          ratio: null
        }
      ]
    }
  }

  throw new Error(`Unsupported archive format: ${ext}`)
}
