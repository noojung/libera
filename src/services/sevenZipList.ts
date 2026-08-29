import { SevenZipError } from './sevenZipError'
import { Libera7zError } from '../lib/libera7z'
import { openLibera7zFile } from './libera7zNode'
import { discoverSevenZipVolumes, isSevenZipVolumePath } from './sevenZipVolumes'

// The inspector, previewer and extractor all use this Libera7z-backed listing,
// keeping positional preview ids aligned with the reader's entry order.

export interface SevenZipEntry {
  path: string
  size: number
  packedSize?: number
  isDirectory: boolean
  isSymlink: boolean
  encrypted: boolean
  mode?: number
  modified?: string
  crc?: string
  codec?: string
  dictionarySize?: number
  solid?: boolean
}

export interface SevenZipListing {
  entries: SevenZipEntry[]
  volumeCount: number
  anyEncrypted: boolean
  anySolid: boolean
  formatVersion: string
  nextHeaderOffset: number
  nextHeaderSize: number
}

export interface ListSevenZipOptions {
  password?: string
  signal?: AbortSignal
  maxEntries?: number
}

/** Lists an archive through the in-process Libera7z reader. */
export async function listSevenZipEntries(
  archivePath: string,
  options: ListSevenZipOptions = {}
): Promise<SevenZipListing> {
  try {
    const archive = await openLibera7zFile(archivePath, {
      signal: options.signal,
      maxEntries: options.maxEntries,
      password: options.password
    })
    try {
      const entries = archive.entries.map(entry => {
        const size = Number(entry.size)
        const packedSize = entry.packedSize === undefined ? undefined : Number(entry.packedSize)
        if (!Number.isSafeInteger(size) || (packedSize !== undefined && !Number.isSafeInteger(packedSize))) {
          throw new SevenZipError('SEVEN_ZIP_FAILED', '7z entry size exceeds JavaScript safe integer range')
        }
        return {
          path: entry.path,
          size,
          packedSize,
          isDirectory: entry.isDirectory,
          isSymlink: entry.isSymlink,
          encrypted: entry.encrypted,
          mode: entry.mode,
          modified: entry.modified?.toISOString(),
          crc: entry.crc?.toString(16).toUpperCase().padStart(8, '0'),
          codec: entry.codec,
          dictionarySize: entry.dictionarySize,
          solid: entry.solid
        }
      })
      const volumeCount = isSevenZipVolumePath(archivePath)
        ? (await discoverSevenZipVolumes(archivePath)).length
        : 1
      const nextHeaderOffset = Number(archive.metadata.nextHeaderOffset)
      const nextHeaderSize = Number(archive.metadata.nextHeaderSize)
      if (!Number.isSafeInteger(nextHeaderOffset) || !Number.isSafeInteger(nextHeaderSize)) {
        throw new SevenZipError('SEVEN_ZIP_FAILED', '7z header position exceeds JavaScript safe integer range')
      }
      return {
        entries,
        volumeCount,
        anyEncrypted: entries.some(entry => entry.encrypted),
        anySolid: entries.some(entry => entry.solid),
        formatVersion: archive.metadata.version,
        nextHeaderOffset,
        nextHeaderSize
      }
    } finally {
      await archive.close()
    }
  } catch (error) {
    if (error instanceof Libera7zError && error.code === 'CANCELLED') {
      throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7z listing was cancelled')
    }
    if (error instanceof Libera7zError && error.code === 'PASSWORD_REQUIRED') {
      throw new SevenZipError('SEVEN_ZIP_PASSWORD_REQUIRED', 'The archive needs a password')
    }
    if (error instanceof Libera7zError && error.code === 'WRONG_PASSWORD') {
      throw new SevenZipError('SEVEN_ZIP_WRONG_PASSWORD', 'Wrong archive password')
    }
    throw error
  }
}
