import type { ProgressCallback } from '../compressor'
import { SevenZipError } from './error'
import { Libera7zError } from 'libera7z'
import { writeLibera7z } from './node'
import { MAX_SEVEN_ZIP_VOLUMES } from './volumes'
import type { SevenZipMethodOverride, SevenZipMethod } from './methodOverrides'
import type { CompressionInputFilters } from '../compressionInputs'

// Writing .7z, the counterpart to zip/splitWriter.ts. Libera7z owns both
// ordinary archives and numbered volume sets without invoking another tool.

export interface SevenZipWriteOptions extends CompressionInputFilters {
  inputPaths: string[]
  outputPath: string
  totalBytes: number
  level: number
  splitSize?: number
  password?: string
  /** Encrypts the header too, so the file names need the password as well. */
  encryptFileNames?: boolean
  dictionarySize?: number
  method?: SevenZipMethod
  methodOverrides?: SevenZipMethodOverride[]
  matchFinderWordSize?: 32 | 64 | 128 | 273
  searchCycles?: number
  solid?: boolean
}

export interface SevenZipWriteResult {
  outputPath: string
  volumePaths?: string[]
}

/**
 * 7-Zip's -mx scale is 0/1/3/5/7/9, so the app's continuous 0-9 slider is
 * mapped onto the nearest real step rather than passed through.
 */
export function sevenZipLevelArgument(level: number): string {
  const clamped = Math.max(0, Math.min(9, Math.round(level)))
  if (clamped === 0) return '-mx=0'
  if (clamped <= 2) return '-mx=1'
  if (clamped <= 4) return '-mx=3'
  if (clamped <= 6) return '-mx=5'
  if (clamped <= 8) return '-mx=7'
  return '-mx=9'
}

export async function writeSevenZipArchive(
  options: SevenZipWriteOptions,
  onProgress?: ProgressCallback,
  context: { signal?: AbortSignal } = {}
): Promise<SevenZipWriteResult> {
  const {
    inputPaths, outputPath, totalBytes, level, splitSize, password, encryptFileNames,
    dictionarySize, method, methodOverrides, matchFinderWordSize, searchCycles, solid,
    excludeSymlinks, excludeMacMetadata, excludeHiddenFiles, filterPattern
  } = options

  if (splitSize !== undefined && Math.ceil(totalBytes / splitSize) > MAX_SEVEN_ZIP_VOLUMES) {
    throw new SevenZipError('SEVEN_ZIP_FAILED', 'The split size produces too many volumes.')
  }

  let currentFile: string | undefined
  try {
    const written = await writeLibera7z({
      inputPaths,
      outputPath,
      level: Number(sevenZipLevelArgument(level).slice('-mx='.length)),
      splitSize,
      password,
      encryptFileNames,
      dictionarySize,
      method,
      methodOverrides,
      matchFinderWordSize,
      searchCycles,
      solid,
      excludeSymlinks,
      excludeMacMetadata,
      excludeHiddenFiles,
      filterPattern,
      signal: context.signal,
      onProgress: (processedBytes, file) => {
        currentFile = file ?? currentFile
        const processed = Number(processedBytes)
        onProgress?.({
          processedBytes: processed,
          totalBytes,
          percent: totalBytes === 0 ? 99 : Math.min(99, Math.round((processed / totalBytes) * 100)),
          phase: 'processing',
          currentFile
        })
      }
    })
    onProgress?.({
      processedBytes: totalBytes,
      totalBytes,
      percent: 100,
      phase: 'complete',
      currentFile
    })
    return written
  } catch (error) {
    // The writer clears up after itself: what it had begun is gone, and what
    // an earlier run left is still where it was. Sweeping here as well is what
    // used to take the previous archive down with a cancelled run.
    if (error instanceof Libera7zError && error.code === 'CANCELLED') {
      throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7z creation was cancelled')
    }
    throw error
  }
}
