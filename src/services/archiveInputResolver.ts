import { promises as fsPromises } from 'fs'
import path from 'path'
import { MAX_ARCHIVE_ENTRIES } from './extractor'
import { canonicalArchivePath, isZipFormatExtension } from './archiveVolumes'
import { isNumberedVolumePath } from './splitZipVolumes'
import { discoverSevenZipVolumes, isSevenZipVolumePath } from './sevenZipVolumes'
import { openZipArchive } from './zipFileReader'

export interface ArchiveVolumeInfo {
  path: string
  name: string
  size: number
}

export interface ResolvedExtractionInput {
  path: string
  name: string
  isDirectory: false
  size: number
  volumes?: ArchiveVolumeInfo[]
}

export interface ExtractionInputResolutionError {
  path: string
  error: string
  errorCode: string
}

export interface ResolveExtractionInputsResult {
  items: ResolvedExtractionInput[]
  errors: ExtractionInputResolutionError[]
}

async function volumeInfo(volumePath: string): Promise<ArchiveVolumeInfo> {
  const stat = await fsPromises.lstat(volumePath)
  if (!stat.isFile()) throw new Error(`Archive volume is not a file: ${volumePath}`)
  return {
    path: volumePath,
    name: path.basename(volumePath) || volumePath,
    size: stat.size
  }
}

/** Resolves one path to the logical archive and every physical volume it needs. */
export async function resolveExtractionInput(inputPath: string): Promise<ResolvedExtractionInput> {
  const archivePath = canonicalArchivePath(inputPath)
  const extension = path.extname(archivePath).toLowerCase()
  let volumes: ArchiveVolumeInfo[]

  if (isSevenZipVolumePath(inputPath)) {
    const volumePaths = await discoverSevenZipVolumes(archivePath)
    volumes = await Promise.all(volumePaths.map(volumeInfo))
  } else if (isNumberedVolumePath(inputPath) || isZipFormatExtension(extension)) {
    // A terminal .zip can be either an ordinary archive or the final volume.
    // Let the existing strict split-aware reader decide instead of trusting a
    // similarly named .z01 file that happens to be beside an ordinary ZIP.
    const archive = await openZipArchive(archivePath, MAX_ARCHIVE_ENTRIES)
    try {
      volumes = archive.volumePaths.map((volumePath, index) => ({
        path: volumePath,
        name: path.basename(volumePath) || volumePath,
        size: archive.volumeSizes[index]
      }))
    } finally {
      await archive.close()
    }
  } else {
    volumes = [await volumeInfo(archivePath)]
  }

  const totalSize = volumes.reduce((sum, volume) => sum + volume.size, 0)
  return {
    path: archivePath,
    name: path.basename(archivePath) || archivePath,
    isDirectory: false,
    size: totalSize,
    ...(volumes.length > 1 ? { volumes } : {})
  }
}
