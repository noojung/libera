import { promises as fsPromises } from 'fs'
import path from 'path'
import type { ProgressCallback } from './compressor'
import { runSevenZip, SevenZipError } from './sevenZip'
import { Libera7zError } from '../lib/libera7z'
import { canFallbackFromLibera7z, writeLibera7z } from './libera7zNode'
import {
  MAX_SEVEN_ZIP_VOLUMES,
  removeStaleSevenZipVolumes,
  sevenZipVolumePath
} from './sevenZipVolumes'

// Writing .7z, the counterpart to splitZipWriter.ts. Libera7z writes ordinary
// and split byte streams; the compatibility executable remains only for input
// features the TypeScript writer does not model yet.

export interface SevenZipWriteOptions {
  inputPaths: string[]
  outputPath: string
  totalBytes: number
  level: number
  splitSize?: number
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

/**
 * Excludes the archive from its own input tree. The default save location sits
 * inside the folder being compressed, so without this 7-Zip would try to add
 * the file it is still writing.
 */
function selfExclusionArguments(outputPath: string): string[] {
  const baseName = path.basename(outputPath)
  return [`-xr!${baseName}`, `-xr!${baseName}.*`, `-xr!${baseName}.tmp`]
}

async function removePartialOutput(outputPath: string): Promise<void> {
  await removeStaleSevenZipVolumes(outputPath).catch(() => undefined)
}

export async function writeSevenZipArchive(
  options: SevenZipWriteOptions,
  onProgress?: ProgressCallback,
  context: { signal?: AbortSignal } = {}
): Promise<SevenZipWriteResult> {
  const { inputPaths, outputPath, totalBytes, level, splitSize } = options

  if (splitSize !== undefined && Math.ceil(totalBytes / splitSize) > MAX_SEVEN_ZIP_VOLUMES) {
    throw new SevenZipError('SEVEN_ZIP_FAILED', 'The split size produces too many volumes.')
  }

  // `7za a` appends to an archive it finds, so anything a previous run left
  // behind has to go first or the two runs merge into an unreadable set.
  await removeStaleSevenZipVolumes(outputPath)

  // The dependency-free writer owns ordinary and split byte streams. Inputs
  // it deliberately does not model yet (notably symbolic links) still fall
  // through to the compatibility executable without changing the UI contract.
  let currentFile: string | undefined
  try {
    const written = await writeLibera7z({
      inputPaths,
      outputPath,
      level: Number(sevenZipLevelArgument(level).slice('-mx='.length)),
      splitSize,
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
    if (error instanceof Libera7zError && error.code === 'CANCELLED') {
      await removePartialOutput(outputPath)
      throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7z creation was cancelled')
    }
    if (!canFallbackFromLibera7z(error)) {
      await removePartialOutput(outputPath)
      throw error
    }
    await removePartialOutput(outputPath)
  }

  const args = [
    'a',
    '-t7z',
    sevenZipLevelArgument(level),
    // -bb1 names each file as it is added; -bsp1 puts the percentage on stdout.
    '-bb1',
    '-bsp1',
    ...selfExclusionArguments(outputPath),
    // Store symbolic links as links rather than following them, which would
    // both inflate the archive and make a link cycle traversable.
    '-snl',
    ...(splitSize !== undefined ? [`-v${splitSize}b`] : []),
    '--',
    outputPath,
    ...inputPaths
  ]

  currentFile = undefined
  try {
    await runSevenZip(args, undefined, {
      signal: context.signal,
      onProgress: progress => {
        if (progress.currentFile !== undefined) currentFile = progress.currentFile
        if (progress.percent < 0) return
        onProgress?.({
          processedBytes: Math.round((progress.percent / 100) * totalBytes),
          totalBytes,
          percent: Math.min(99, progress.percent),
          phase: 'processing',
          currentFile
        })
      }
    })
  } catch (error) {
    await removePartialOutput(outputPath)
    throw error
  }

  onProgress?.({
    processedBytes: totalBytes,
    totalBytes,
    percent: 100,
    phase: 'complete',
    currentFile
  })

  if (splitSize === undefined) return { outputPath }

  // A split set is numbered even when it fits in one volume, so the archive
  // the caller should open is always .001 - the opposite end from a ZIP set.
  const volumePaths: string[] = []
  for (let volumeNumber = 1; volumeNumber <= MAX_SEVEN_ZIP_VOLUMES; volumeNumber += 1) {
    const volumePath = sevenZipVolumePath(outputPath, volumeNumber)
    const exists = await fsPromises.stat(volumePath).then(() => true, () => false)
    if (!exists) break
    volumePaths.push(volumePath)
  }

  if (volumePaths.length === 0) {
    throw new SevenZipError('SEVEN_ZIP_FAILED', '7-Zip reported success but produced no volumes.')
  }

  return { outputPath: volumePaths[0], volumePaths }
}
