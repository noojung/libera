import { promises as fsPromises } from 'fs'
import type { ProgressCallback } from '../compressor'
import { SevenZipError } from './error'
import { Libera7zError, type SevenZipArchive } from '../../lib/libera7z'
import { openLibera7zFile } from './node'
import type { ExtractionOptions } from '../extractor'
import {
  archivePermissions,
  buildExtractionPlan,
  createArchiveEntryFilter,
  createOwnedSymlink,
  createOwnedWebWriter,
  ensureSafeDirectory,
  ensureSafeParentDirectories,
  ExtractionMeter,
  ExtractionTransaction,
  extractionError,
  isMacMetadataPath,
  matchesSelectedEntry,
  prepareSelectedDestinations,
  propagateQuarantine,
  restoresSymbolicLinks,
  restoresUnixMode,
  securityError,
  throwIfAborted,
  topLevelSegment,
  type ExtractionPolicy,
  type PlannedEntry
} from '../extractionSafety'

// Libera7z yields bounded entry streams, while the ordinary extraction safety
// layer remains responsible for paths, links, quotas, permissions and cleanup.

async function readLiberaLinkTargets(
  archive: SevenZipArchive,
  links: readonly { id: number; path: string; size: bigint }[],
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  if (links.length === 0) return targets
  const byId = new Map(links.map(link => [link.id, link]))
  const chunks = new Map<number, Buffer[]>()
  const lengths = new Map<number, number>()
  const reader = archive.openEntries(links.map(link => link.id), { signal }).getReader()
  try {
    while (true) {
      throwIfAborted(signal)
      const item = await reader.read()
      if (item.done) break
      const event = item.value
      if (event.type === 'entry-start') {
        chunks.set(event.entry.id, [])
        lengths.set(event.entry.id, 0)
      } else if (event.type === 'data') {
        const link = byId.get(event.entryId)
        const targetChunks = chunks.get(event.entryId)
        if (!link || !targetChunks) throw securityError('7z symbolic-link data arrived out of order')
        const nextLength = (lengths.get(event.entryId) ?? 0) + event.bytes.length
        if (BigInt(nextLength) > link.size) throw securityError(`symlink entry exceeds its declared size: ${link.path}`)
        lengths.set(event.entryId, nextLength)
        targetChunks.push(Buffer.from(event.bytes))
      } else {
        const link = byId.get(event.entry.id)
        const targetChunks = chunks.get(event.entry.id)
        const length = lengths.get(event.entry.id)
        if (!link || !targetChunks || length === undefined || BigInt(length) !== link.size) {
          throw securityError(`symlink entry is truncated: ${link?.path ?? event.entry.path}`)
        }
        targets.set(link.path, Buffer.concat(targetChunks, length).toString('utf8'))
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return targets
}

async function extractWithJavaScript(
  archive: SevenZipArchive,
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
  extractionOptions?: ExtractionOptions
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const options = extractionOptions ?? { archivePath, targetDir: targetRoot }
  const requestedPaths = selectedEntries ? new Set(selectedEntries) : null
  const filter = createArchiveEntryFilter(options.filterPattern)
  const needsDerivedSelection = Boolean(
    requestedPaths || options.filterPattern || options.excludeMacMetadata || options.restoreSymlinks === false
  )
  const selectedPaths = needsDerivedSelection
    ? new Set(archive.entries
      .filter(entry => matchesSelectedEntry(entry.path, requestedPaths))
      .filter(entry => filter(entry.path))
      .filter(entry => !options.excludeMacMetadata || !isMacMetadataPath(entry.path))
      .filter(entry => options.restoreSymlinks !== false || !entry.isSymlink)
      .map(entry => entry.path))
    : null
  const selectedLinks = archive.entries.filter(entry =>
    entry.isSymlink && matchesSelectedEntry(entry.path, selectedPaths))
  const linkTargets = restoresSymbolicLinks && options.restoreSymlinks !== false
    ? await readLiberaLinkTargets(archive, selectedLinks, signal)
    : new Map<string, string>()
  const plan = buildExtractionPlan(
    archive.entries.map(entry => {
      const size = Number(entry.size)
      if (!Number.isSafeInteger(size)) throw securityError(`entry size exceeds JavaScript's safe range: ${entry.path}`)
      return {
        archivePath: entry.path,
        isDirectory: entry.isDirectory,
        size: entry.isDirectory ? 0 : size,
        isLink: entry.isSymlink,
        linkTarget: linkTargets.get(entry.path),
        mode: restoresUnixMode && options.restorePermissions !== false ? entry.mode : undefined,
        source: entry.id
      }
    }),
    targetRoot,
    selectedPaths,
    policy
  )
  if (plan.selectedTotalBytes > diskBudget) {
    throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for extraction and the configured reserve')
  }
  await prepareSelectedDestinations(
    targetRoot,
    plan.entries,
    options.overwritePolicy ?? 'reject',
    transaction
  )

  const selected = plan.entries.filter(entry => entry.shouldExtract)
  const topLevelNames = new Set(selected.map(entry => topLevelSegment(entry.archivePath)))
  for (const entry of selected) {
    if (entry.isDirectory) await ensureSafeDirectory(targetRoot, entry.outputPath, transaction)
    else await ensureSafeParentDirectories(targetRoot, entry.outputPath, transaction)
  }

  const meter = new ExtractionMeter(policy, diskBudget, plan.selectedTotalBytes, onProgress)
  let extractedCount = 0
  for (const entry of selected) {
    if (!entry.isLink) continue
    throwIfAborted(signal)
    meter.consume(entry.size, 0, entry.archivePath)
    await createOwnedSymlink(entry.outputPath, entry.linkTarget!, transaction)
    extractedCount += 1
  }
  const selectedFiles = selected.filter(entry => !entry.isDirectory && !entry.isLink)
  const entriesById = new Map(selectedFiles.map(entry => [entry.source as number, entry]))
  const reader = archive.openEntries([...entriesById.keys()], { signal }).getReader()
  let currentEntry: PlannedEntry | null = null
  let currentBytes = 0
  let currentOutput: Awaited<ReturnType<typeof createOwnedWebWriter>> | null = null
  let currentWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  try {
    while (true) {
      throwIfAborted(signal)
      const item = await reader.read()
      if (item.done) break
      const event = item.value
      if (event.type === 'entry-start') {
        if (currentEntry) throw securityError('7z entry streams overlap')
        const entry = entriesById.get(event.entry.id)
        if (!entry) throw securityError(`7z returned an unselected entry: ${event.entry.path}`)
        currentEntry = entry
        currentBytes = 0
        currentOutput = await createOwnedWebWriter(entry.outputPath, transaction, byteLength => {
          currentBytes = meter.consume(byteLength, currentBytes, entry.archivePath)
        })
        currentWriter = currentOutput.writable.getWriter()
      } else if (event.type === 'data') {
        if (!currentEntry || !currentWriter || currentEntry.source !== event.entryId) {
          throw securityError('7z entry data arrived outside its declared boundary')
        }
        await currentWriter.write(event.bytes)
      } else {
        if (!currentEntry || !currentWriter || !currentOutput || currentEntry.source !== event.entry.id) {
          throw securityError('7z entry ended outside its declared boundary')
        }
        await currentWriter.close()
        currentWriter = null
        await currentOutput.close()
        currentOutput = null
        if (currentBytes !== currentEntry.size) {
          throw securityError(
            `archive declares ${currentEntry.size} bytes but supplied ${currentBytes}: ${currentEntry.archivePath}`
          )
        }
        const mode = currentEntry.mode !== undefined ? archivePermissions(currentEntry.mode) : undefined
        if (mode !== undefined) await fsPromises.chmod(currentEntry.outputPath, mode)
        if (options.restoreTimestamps === true) {
          const source = archive.entries[currentEntry.source as number]
          if (source?.modified) await fsPromises.utimes(currentEntry.outputPath, source.modified, source.modified)
        }
        extractedCount += 1
        currentEntry = null
      }
    }
    if (currentEntry) throw securityError(`7z entry ended early: ${currentEntry.archivePath}`)
  } catch (error) {
    await currentWriter?.abort().catch(() => undefined)
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    await currentOutput?.close().catch(() => undefined)
  }
  meter.complete()
  await propagateQuarantine(archivePath, targetRoot, topLevelNames)
  return { targetDir: targetRoot, extractedCount, durationMs: Date.now() - startTime }
}

export async function extractSevenZipArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  password: string | undefined,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
  extractionOptions?: ExtractionOptions
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  let archive: SevenZipArchive
  try {
    archive = await openLibera7zFile(archivePath, { signal, maxEntries: policy.maxEntries, password })
  } catch (error) {
    if (error instanceof Libera7zError && error.code === 'CANCELLED') throwIfAborted(signal)
    if (error instanceof Libera7zError && error.code === 'PASSWORD_REQUIRED') {
      throw new SevenZipError('SEVEN_ZIP_PASSWORD_REQUIRED', 'The archive needs a password')
    }
    if (error instanceof Libera7zError && error.code === 'WRONG_PASSWORD') {
      throw new SevenZipError('SEVEN_ZIP_WRONG_PASSWORD', 'Wrong archive password')
    }
    throw error
  }
  try {
    return await extractWithJavaScript(
      archive,
      archivePath,
      targetRoot,
      selectedEntries,
      startTime,
      policy,
      diskBudget,
      transaction,
      signal,
      onProgress,
      extractionOptions
    ).catch(error => {
      if (error instanceof Libera7zError && error.code === 'PASSWORD_REQUIRED') {
        throw new SevenZipError('SEVEN_ZIP_PASSWORD_REQUIRED', 'The archive needs a password')
      }
      if (error instanceof Libera7zError && error.code === 'WRONG_PASSWORD') {
        throw new SevenZipError('SEVEN_ZIP_WRONG_PASSWORD', 'Wrong archive password')
      }
      throw error
    })
  } finally {
    await archive.close()
  }
}
