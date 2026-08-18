import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import {
  ERR_ENCRYPTED,
  ERR_INVALID_PASSWORD,
  TextWriter,
  Uint8ArrayWriter,
  type Entry,
  type FileEntry
} from '@zip.js/zip.js'
import * as tar from 'tar'
import zlib from 'zlib'
import type { ProgressCallback } from './compressor'
import { openZipArchive } from './zipFileReader'
import { isNumberedVolumePath } from './splitZipVolumes'
import { canonicalArchivePath } from './archiveVolumes'
import { isSevenZipArchivePath, isSevenZipVolumePath } from './sevenZipVolumes'
import { extractSevenZipArchive } from './sevenZipExtractor'
import {
  applyAppleDouble,
  appleDoubleSubjectPath,
  MAX_APPLE_DOUBLE_BYTES,
  parseAppleDouble,
  type AppleDoubleMetadata
} from './appleDouble'
import {
  archivePermissions,
  assertSafeDestination,
  buildExtractionPlan,
  calculateUsableExtractionBytes,
  createOwnedSymlink,
  createOwnedWebWriter,
  defaultAvailableBytes,
  DEFAULT_EXTRACTION_POLICY,
  ensureSafeDirectory,
  ensureSafeParentDirectories,
  ExtractionError,
  ExtractionMeter,
  ExtractionTransaction,
  extractionError,
  matchesSelectedEntry,
  normalizeEntryPath,
  normalizeExtractionError,
  openOwnedNodeWriteStream,
  prepareTargetRoot,
  propagateQuarantine,
  resolveOutputPath,
  restoresSymbolicLinks,
  restoresUnixMode,
  securityError,
  throwIfAborted,
  topLevelSegment,
  validateSelectedDestinations,
  WRONG_ZIP_PASSWORD_ERROR_CODE,
  type ArchivePlanEntry,
  type ExtractionContext,
  type ExtractionPolicy
} from './extractionSafety'

// The safety core moved out of this file; re-exported so every existing
// importer of extractor.ts keeps working unchanged.
export * from './extractionSafety'

export interface ExtractionOptions {
  archivePath: string
  targetDir: string
  selectedEntries?: string[]
  password?: string
}

export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz', '.7z'] as const

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  if (SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))) return true
  // Neither `.z01` nor `.7z.001` ends in a supported extension.
  return isNumberedVolumePath(normalizedPath) || isSevenZipVolumePath(normalizedPath)
}

export function isWrongZipPasswordError(error: unknown): boolean {
  if (error instanceof ExtractionError) return error.code === WRONG_ZIP_PASSWORD_ERROR_CODE
  const message = error instanceof Error ? error.message : String(error)
  return message === ERR_INVALID_PASSWORD || message === ERR_ENCRYPTED || /wrong password/i.test(message)
}
// Only macOS has anywhere to put the metadata a sidecar carries; elsewhere the
// sidecars stay ordinary files, which is what every other unzip tool does.
const mergesAppleDouble = process.platform === 'darwin'
function zipUnixMode(entry: Entry): number {
  return entry.unixMode ?? ((entry.externalFileAttributes >>> 16) & 0xffff)
}

function isZipSymbolicLink(entry: Entry): boolean {
  return (zipUnixMode(entry) & 0o170000) === 0o120000
}

async function extractZipArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  password: string | undefined,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const zip = await openZipArchive(archivePath, policy.maxEntries, { password })
  try {
    if (zip.entries.length > policy.maxEntries) {
      throw securityError(`archive contains more than ${policy.maxEntries.toLocaleString()} entries`, 'TOO_MANY_ENTRIES')
    }
    const selectedPaths = selectedEntries ? new Set(selectedEntries) : null
    const archiveEntries: ArchivePlanEntry[] = []
    const entryNames = new Set(zip.entries.map(entry => entry.filename))
    // Sidecars are folded onto their subject rather than written out, keyed by
    // the archive path of the file they describe.
    const sidecars = new Map<string, AppleDoubleMetadata>()

    for (const entry of zip.entries) {
      if (mergesAppleDouble) {
        const subjectPath = appleDoubleSubjectPath(entry.filename)
        const foldsIntoSubject = subjectPath !== null &&
          !entry.directory &&
          entryNames.has(subjectPath) &&
          matchesSelectedEntry(subjectPath, selectedPaths) &&
          Number(entry.uncompressedSize) <= MAX_APPLE_DOUBLE_BYTES
        if (foldsIntoSubject) {
          const raw = await (entry as FileEntry).getData(new Uint8ArrayWriter(), { password })
          const metadata = parseAppleDouble(Buffer.from(raw))
          // Bytes that are not AppleDouble belong to a file that merely looks
          // like a sidecar, and fall through to normal extraction.
          if (metadata) {
            sidecars.set(subjectPath!, metadata)
            continue
          }
        }
      }

      const isLink = isZipSymbolicLink(entry)
      // Only entries slated for extraction get their target read, so an
      // unselected, undecryptable symlink can't block the rest of the archive.
      // Leaving the target unread on Windows is what falls back to rejecting
      // the entry, since the plan treats a link without a target as unsupported.
      const linkTarget = isLink && restoresSymbolicLinks && !entry.directory &&
        matchesSelectedEntry(entry.filename, selectedPaths)
        ? await (entry as FileEntry).getData(new TextWriter(), { password })
        : undefined
      archiveEntries.push({
        archivePath: entry.filename,
        isDirectory: entry.directory,
        size: entry.directory ? 0 : Number(entry.uncompressedSize),
        isLink,
        linkTarget,
        mode: restoresUnixMode ? archivePermissions(zipUnixMode(entry)) : undefined,
        source: entry
      })
    }
    const plan = buildExtractionPlan(archiveEntries, targetRoot, selectedPaths, policy)
    if (plan.selectedTotalBytes > diskBudget) {
      throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for extraction and the configured reserve')
    }
    await validateSelectedDestinations(targetRoot, plan.entries)

    const meter = new ExtractionMeter(policy, diskBudget, plan.selectedTotalBytes, onProgress)
    let extractedCount = 0
    for (const entry of plan.entries.filter(item => item.shouldExtract)) {
      throwIfAborted(signal)
      if (entry.isDirectory) {
        await ensureSafeDirectory(targetRoot, entry.outputPath, transaction)
        continue
      }

      await ensureSafeParentDirectories(targetRoot, entry.outputPath, transaction)

      if (entry.isLink) {
        await createOwnedSymlink(entry.outputPath, entry.linkTarget!, transaction)
        meter.consume(entry.size, 0, entry.archivePath)
        extractedCount++
        continue
      }

      let fileBytes = 0
      const output = await createOwnedWebWriter(entry.outputPath, transaction, byteLength => {
        fileBytes = meter.consume(byteLength, fileBytes, entry.archivePath)
      })
      try {
        await (entry.source as FileEntry).getData(output.writable, {
          password,
          signal,
          strictness: 'strict',
          checkCrc32: true,
          checkOverlappingEntry: true,
          useWebWorkers: false
        })
      } finally {
        await output.close()
      }
      // Metadata goes on while the file is still owner writable, since a
      // read-only mode would block the resource fork write.
      const sidecar = sidecars.get(entry.archivePath)
      if (sidecar) await applyAppleDouble(entry.outputPath, sidecar)
      // Widened only now that the contents are complete, so a half written file
      // is never executable and never readable by anyone but the owner.
      if (entry.mode !== undefined) await fsPromises.chmod(entry.outputPath, entry.mode)
      extractedCount++
    }

    meter.complete()
    const topLevelNames = new Set(
      plan.entries.filter(entry => entry.shouldExtract).map(entry => topLevelSegment(entry.archivePath))
    )
    await propagateQuarantine(archivePath, targetRoot, topLevelNames)
    return { targetDir: targetRoot, extractedCount, durationMs: Date.now() - startTime }
  } finally {
    await zip.close()
  }
}

async function listTarEntries(
  archivePath: string,
  policy: ExtractionPolicy,
  signal?: AbortSignal
): Promise<ArchivePlanEntry[]> {
  const entries: ArchivePlanEntry[] = []
  let limitError: ExtractionError | null = null
  const listingReference: { current?: { destroy(error?: Error): void } } = {}
  const listing = tar.t({
    strict: true,
    onentry: (entry: any) => {
      const allowedTypes = new Set(['File', 'OldFile', 'Directory'])
      entries.push({
        archivePath: entry.path,
        isDirectory: entry.type === 'Directory',
        size: Number(entry.size || 0),
        isLink: !allowedTypes.has(entry.type)
      })
      if (entries.length > policy.maxEntries) {
        limitError = securityError(`archive contains more than ${policy.maxEntries.toLocaleString()} entries`, 'TOO_MANY_ENTRIES')
        listingReference.current?.destroy(limitError)
      }
    }
  })
  listingReference.current = listing as unknown as { destroy(error?: Error): void }

  try {
    await pipeline(fs.createReadStream(archivePath), listing, { signal })
  } catch (error) {
    if (limitError) throw limitError
    throw error
  }
  return entries
}

async function extractTarArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const selectedPaths = selectedEntries ? new Set(selectedEntries) : null
  const plan = buildExtractionPlan(await listTarEntries(archivePath, policy, signal), targetRoot, selectedPaths, policy)
  if (plan.selectedTotalBytes > diskBudget) {
    throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for extraction and the configured reserve')
  }
  await validateSelectedDestinations(targetRoot, plan.entries)

  const selectedPlan = plan.entries.filter(entry => entry.shouldExtract)
  for (const entry of selectedPlan) {
    if (entry.isDirectory) await ensureSafeDirectory(targetRoot, entry.outputPath, transaction)
    else await ensureSafeParentDirectories(targetRoot, entry.outputPath, transaction)
  }

  const plannedEntries = new Map(plan.entries.map(entry => [entry.archivePath, entry]))
  const meter = new ExtractionMeter(policy, diskBudget, plan.selectedTotalBytes, onProgress)
  const limitController = new AbortController()
  const operationSignal = signal ? AbortSignal.any([signal, limitController.signal]) : limitController.signal
  let meterError: unknown
  const extractor = tar.x({
    cwd: targetRoot,
    strict: true,
    keep: true,
    preservePaths: false,
    preserveOwner: false,
    filter: (entryPath: string) => plannedEntries.get(entryPath)?.shouldExtract === true,
    onentry: (tarEntry: any) => {
      const plannedEntry = plannedEntries.get(tarEntry.path)
      if (!plannedEntry?.shouldExtract || plannedEntry.isDirectory) return
      transaction.recordFile(plannedEntry.outputPath)
    },
    transform: (tarEntry: any) => {
      const plannedEntry = plannedEntries.get(tarEntry.path)
      if (!plannedEntry?.shouldExtract || plannedEntry.isDirectory) return undefined

      let fileBytes = 0
      const byteMeter = new Transform({
        transform(chunk: Buffer, _, callback) {
          try {
            fileBytes = meter.consume(chunk.length, fileBytes, plannedEntry.archivePath)
            callback(null, chunk)
          } catch (error) {
            meterError = error
            limitController.abort(error)
            callback(error as Error)
          }
        }
      })
      // tar's runtime accepts Node transform streams for asynchronous extraction,
      // while its public type currently narrows this option to ReadEntry.
      return byteMeter as unknown as typeof tarEntry
    }
  })

  try {
    await pipeline(fs.createReadStream(archivePath), extractor, { signal: operationSignal })
  } catch (error) {
    if (meterError) throw meterError
    throw error
  }

  meter.complete()
  const topLevelNames = new Set(selectedPlan.map(entry => topLevelSegment(entry.archivePath)))
  await propagateQuarantine(archivePath, targetRoot, topLevelNames)
  return {
    targetDir: targetRoot,
    extractedCount: selectedPlan.filter(entry => !entry.isDirectory).length,
    durationMs: Date.now() - startTime
  }
}

async function extractGzArchive(
  archivePath: string,
  targetRoot: string,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const outputName = normalizeEntryPath(path.basename(archivePath, '.gz'))
  const outputPath = resolveOutputPath(targetRoot, outputName)
  await assertSafeDestination(targetRoot, outputPath, false)
  await ensureSafeParentDirectories(targetRoot, outputPath, transaction)

  const meter = new ExtractionMeter(policy, diskBudget, null, onProgress)
  let fileBytes = 0
  const byteLimit = new Transform({
    transform(chunk: Buffer, _, callback) {
      try {
        fileBytes = meter.consume(chunk.length, fileBytes, outputName)
        callback(null, chunk)
      } catch (error) {
        callback(error as Error)
      }
    }
  })
  const output = await openOwnedNodeWriteStream(outputPath, transaction)

  try {
    await pipeline(
      fs.createReadStream(archivePath),
      zlib.createGunzip(),
      byteLimit,
      output.stream,
      { signal }
    )
  } finally {
    await output.handle.close().catch(() => undefined)
  }

  meter.complete(outputName)
  await propagateQuarantine(archivePath, targetRoot, [outputName])
  return { targetDir: targetRoot, extractedCount: 1, durationMs: Date.now() - startTime }
}

export async function extractArchive(
  options: ExtractionOptions,
  onProgress?: ProgressCallback,
  context: ExtractionContext = {}
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const startTime = Date.now()
  const { targetDir, selectedEntries, password } = options
  // Any volume of a split set identifies the set; reads start from the volume
  // that carries the central directory.
  const archivePath = canonicalArchivePath(options.archivePath)
  const policy = { ...DEFAULT_EXTRACTION_POLICY, ...context.policy }
  const transaction = new ExtractionTransaction()
  let targetRoot: string | undefined

  try {
    throwIfAborted(context.signal)
    const archiveStat = await fsPromises.lstat(archivePath).catch(() => null)
    if (!archiveStat) throw new Error(`Archive file does not exist: ${archivePath}`)
    if (!archiveStat.isFile()) throw new Error('Extraction requires an archive file, not a folder')
    if (!isSupportedArchivePath(archivePath)) {
      throw new Error(`Unsupported archive format for extraction: ${path.extname(archivePath).toLowerCase()}`)
    }

    targetRoot = await prepareTargetRoot(targetDir, transaction)
    const availableBytes = await (context.getAvailableBytes ?? defaultAvailableBytes)(targetRoot)
    const diskBudget = calculateUsableExtractionBytes(availableBytes, policy)
    if (diskBudget <= 0) {
      throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space to preserve the configured reserve')
    }

    const ext = path.extname(archivePath).toLowerCase()
    const fullExt = archivePath.toLowerCase()
    if (ext === '.zip') {
      return await extractZipArchive(
        archivePath, targetRoot, selectedEntries, password, startTime, policy,
        diskBudget, transaction, context.signal, onProgress
      )
    }
    if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
      return await extractTarArchive(
        archivePath, targetRoot, selectedEntries, startTime, policy,
        diskBudget, transaction, context.signal, onProgress
      )
    }
    if (isSevenZipArchivePath(archivePath)) {
      return await extractSevenZipArchive(
        archivePath, targetRoot, selectedEntries, password, startTime, policy,
        diskBudget, transaction, context.signal, onProgress
      )
    }
    if (ext === '.gz') {
      return await extractGzArchive(
        archivePath, targetRoot, startTime, policy, diskBudget,
        transaction, context.signal, onProgress
      )
    }
    throw new Error(`Unsupported archive format for extraction: ${ext}`)
  } catch (error) {
    await transaction.rollback()
    throw normalizeExtractionError(error, context.signal, isWrongZipPasswordError)
  }
}
