import { promises as fs } from 'fs'
import path from 'path'
import { DmgReader, type DmgEntry } from './reader'
import { createArchiveEntryFilter } from '../entryPatterns'
import {
  archivePermissions, buildExtractionPlan, createOwnedSymlink, createOwnedWebWriter,
  ensureSafeDirectory, ensureSafeParentDirectories, extractionError, ExtractionMeter,
  isMacMetadataPath, matchesSelectedEntry, prepareSelectedDestinations, propagateQuarantine,
  securityError, throwIfAborted, topLevelOutputName, type ArchivePlanEntry, type FormatExtractor
} from '../extractionSafety'

export const extractDmgArchive: FormatExtractor = async request => {
  const { archivePath, targetRoot, selectedEntries, policy, diskBudget, transaction, signal, onProgress, options, startTime } = request
  const reader = await DmgReader.open(archivePath, policy.maxEntries, signal)
  try {
    const selected = selectedEntries ? new Set(selectedEntries) : null
    const filter = createArchiveEntryFilter(options?.filterPattern)
    const entries: ArchivePlanEntry[] = []
    let symbolicLinksExcluded = 0
    for (const entry of reader.entries) {
      throwIfAborted(signal)
      if (!matchesSelectedEntry(entry.path, selected) || !filter(entry.path) ||
          (options?.excludeMacMetadata && isMacMetadataPath(entry.path))) continue
      let linkTarget: string | undefined
      if (entry.isLink) {
        if (options?.restoreSymlinks === false) { symbolicLinksExcluded++; continue }
        linkTarget = entry.linkTarget
        if (linkTarget === undefined) {
          const chunks: Buffer[] = []
          await reader.read(entry, 4096, async bytes => { chunks.push(bytes) }, signal)
          linkTarget = Buffer.concat(chunks).toString('utf8')
        }
        // Installer images commonly link /Applications. Those shortcuts are
        // not payload files, and must never escape the extraction directory.
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), linkTarget))
        if (!linkTarget || linkTarget.includes('\0') || linkTarget.includes('\\') ||
            path.posix.isAbsolute(linkTarget) || /^[a-z]:/i.test(linkTarget) || resolved === '..' || resolved.startsWith('../')) {
          symbolicLinksExcluded++
          continue
        }
      }
      entries.push({ archivePath: entry.path, isDirectory: entry.isDirectory, size: entry.size,
        isLink: entry.isLink, linkTarget, source: entry,
        mode: options?.restorePermissions === false || process.platform === 'win32' || entry.mode === undefined
          ? undefined : archivePermissions(entry.mode) })
    }
    const plan = buildExtractionPlan(entries, targetRoot, null, policy)
    if (plan.selectedTotalBytes > diskBudget) throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space to extract the DMG')
    await prepareSelectedDestinations(targetRoot, plan.entries, options?.overwritePolicy ?? 'reject', transaction)
    const meter = new ExtractionMeter(policy, diskBudget, plan.selectedTotalBytes, onProgress)
    const outputEntries = plan.entries.filter(entry => entry.shouldExtract)
    let extractedCount = 0
    for (const entry of outputEntries) {
      throwIfAborted(signal)
      if (entry.isDirectory) { await ensureSafeDirectory(targetRoot, entry.outputPath, transaction); continue }
      await ensureSafeParentDirectories(targetRoot, entry.outputPath, transaction)
      if (entry.isLink) {
        await createOwnedSymlink(entry.outputPath, entry.linkTarget!, transaction)
        meter.consume(entry.size, 0, entry.archivePath)
      } else {
        let written = 0
        const output = await createOwnedWebWriter(entry.outputPath, transaction, count => {
          written = meter.consume(count, written, entry.archivePath)
        })
        const writer = output.writable.getWriter()
        try {
          await reader.read(entry.source as DmgEntry, entry.size, bytes => writer.write(bytes), signal)
          await writer.close()
          if (written !== entry.size) throw securityError(`DMG entry size does not match: ${entry.archivePath}`)
        } catch (error) {
          await writer.abort().catch(() => undefined)
          throw error
        } finally { await output.close() }
        if (entry.mode !== undefined) await fs.chmod(entry.outputPath, entry.mode)
        const date = (entry.source as DmgEntry).date
        if (options?.restoreTimestamps === true && date) {
          const modified = new Date(date)
          if (Number.isFinite(modified.getTime())) await fs.utimes(entry.outputPath, modified, modified)
        }
      }
      extractedCount++
    }
    meter.complete()
    await propagateQuarantine(archivePath, targetRoot, outputEntries.map(entry => topLevelOutputName(targetRoot, entry.outputPath)))
    return { targetDir: targetRoot, extractedCount, symbolicLinksExcluded, durationMs: Date.now() - startTime }
  } finally { await reader.close() }
}
