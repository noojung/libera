import fs, { promises as fsPromises } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
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
import { isNumberedVolumePath, terminalVolumePath } from './splitZipVolumes'
import {
  applyAppleDouble,
  appleDoubleSubjectPath,
  MAX_APPLE_DOUBLE_BYTES,
  parseAppleDouble,
  type AppleDoubleMetadata
} from './appleDouble'

export interface ExtractionOptions {
  archivePath: string
  targetDir: string
  selectedEntries?: string[]
  password?: string
}

export interface ExtractionPolicy {
  maxEntries: number
  maxTotalBytes: number
  maxFileBytes: number
  minimumReserveBytes: number
  reserveRatioPercent: number
}

export interface ExtractionContext {
  signal?: AbortSignal
  policy?: Partial<ExtractionPolicy>
  getAvailableBytes?: (targetRoot: string) => Promise<bigint>
}

export type ExtractionErrorCode =
  | 'WRONG_ZIP_PASSWORD'
  | 'EXTRACTION_CANCELLED'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'DESTINATION_FILE_TOO_LARGE'
  | 'TOO_MANY_ENTRIES'
  | 'ARCHIVE_TOO_LARGE'
  | 'FILE_TOO_LARGE'
  | 'DESTINATION_EXISTS'
  | 'UNSAFE_ARCHIVE'

interface PlannedEntry {
  archivePath: string
  outputPath: string
  isDirectory: boolean
  size: number
  shouldExtract: boolean
  source?: unknown
  isLink?: boolean
  linkTarget?: string
  mode?: number
}

interface ExtractionPlan {
  entries: PlannedEntry[]
  selectedTotalBytes: number
}

interface ArchivePlanEntry {
  archivePath: string
  isDirectory: boolean
  size: number
  isLink?: boolean
  linkTarget?: string
  mode?: number
  source?: unknown
}

export const WRONG_ZIP_PASSWORD_ERROR_CODE = 'WRONG_ZIP_PASSWORD'
export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz'] as const
export const MAX_ARCHIVE_ENTRIES = 100_000
export const MAX_TOTAL_EXTRACTED_BYTES = 1024 ** 4
export const MAX_FILE_EXTRACTED_BYTES = 1024 ** 4
export const MINIMUM_DISK_RESERVE_BYTES = 1024 ** 3
export const DISK_RESERVE_RATIO_PERCENT = 5

export const DEFAULT_EXTRACTION_POLICY: ExtractionPolicy = {
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxTotalBytes: MAX_TOTAL_EXTRACTED_BYTES,
  maxFileBytes: MAX_FILE_EXTRACTED_BYTES,
  minimumReserveBytes: MINIMUM_DISK_RESERVE_BYTES,
  reserveRatioPercent: DISK_RESERVE_RATIO_PERCENT
}

export class ExtractionError extends Error {
  constructor(public readonly code: ExtractionErrorCode, message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}

class ExtractionTransaction {
  private readonly files = new Set<string>()
  private readonly directories = new Set<string>()

  recordFile(filePath: string): void {
    this.files.add(filePath)
  }

  recordDirectory(directoryPath: string): void {
    this.directories.add(directoryPath)
  }

  async rollback(): Promise<void> {
    for (const filePath of Array.from(this.files).reverse()) {
      await this.removeWithRetries(() => fsPromises.unlink(filePath))
    }

    const directories = Array.from(this.directories)
      .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length)
    for (const directoryPath of directories) {
      await this.removeWithRetries(() => fsPromises.rmdir(directoryPath))
    }
  }

  private async removeWithRetries(remove: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await remove()
        return
      } catch (error: any) {
        if (error.code === 'ENOENT') return
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 4) return
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
  }
}

class ExtractionMeter {
  private processedBytes = 0

  constructor(
    private readonly policy: ExtractionPolicy,
    private readonly diskBudget: number,
    private readonly totalBytes: number | null,
    private readonly onProgress?: ProgressCallback
  ) {}

  consume(byteLength: number, fileBytes: number, currentFile: string): number {
    const nextFileBytes = fileBytes + byteLength
    const nextProcessedBytes = this.processedBytes + byteLength
    if (nextFileBytes > this.policy.maxFileBytes) {
      throw extractionError('FILE_TOO_LARGE', `entry exceeds the ${formatBinaryBytes(this.policy.maxFileBytes)} file size limit: ${currentFile}`)
    }
    if (nextProcessedBytes > this.policy.maxTotalBytes) {
      throw extractionError('ARCHIVE_TOO_LARGE', `archive exceeds the ${formatBinaryBytes(this.policy.maxTotalBytes)} extraction limit`)
    }
    if (nextProcessedBytes > this.diskBudget) {
      throw extractionError('INSUFFICIENT_DISK_SPACE', 'extraction would consume the reserved free disk space')
    }

    this.processedBytes = nextProcessedBytes
    const percent = this.totalBytes === null
      ? null
      : this.totalBytes === 0
        ? 100
        : Math.min(99, Math.round((this.processedBytes / this.totalBytes) * 100))
    this.onProgress?.({
      processedBytes: this.processedBytes,
      totalBytes: this.totalBytes,
      percent,
      phase: 'processing',
      currentFile
    })
    return nextFileBytes
  }

  complete(currentFile?: string): void {
    this.onProgress?.({
      processedBytes: this.processedBytes,
      totalBytes: this.totalBytes ?? this.processedBytes,
      percent: 100,
      phase: 'complete',
      currentFile
    })
  }
}

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  if (SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))) return true
  return isNumberedVolumePath(normalizedPath)
}

export function isWrongZipPasswordError(error: unknown): boolean {
  if (error instanceof ExtractionError) return error.code === WRONG_ZIP_PASSWORD_ERROR_CODE
  const message = error instanceof Error ? error.message : String(error)
  return message === ERR_INVALID_PASSWORD || message === ERR_ENCRYPTED || /wrong password/i.test(message)
}

export function calculateUsableExtractionBytes(availableBytes: bigint, policy: ExtractionPolicy): number {
  const minimumReserve = BigInt(policy.minimumReserveBytes)
  const ratioReserve = (availableBytes * BigInt(policy.reserveRatioPercent)) / 100n
  const reserve = ratioReserve > minimumReserve ? ratioReserve : minimumReserve
  const usable = availableBytes > reserve ? availableBytes - reserve : 0n
  const hardLimit = BigInt(policy.maxTotalBytes)
  return Number(usable < hardLimit ? usable : hardLimit)
}

function formatBinaryBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${bytes / 1024 ** 4} TiB`
  if (bytes >= 1024 ** 3) return `${bytes / 1024 ** 3} GiB`
  if (bytes >= 1024 ** 2) return `${bytes / 1024 ** 2} MiB`
  return `${bytes} bytes`
}

function extractionError(code: ExtractionErrorCode, message: string): ExtractionError {
  const unsafeCodes: ExtractionErrorCode[] = [
    'TOO_MANY_ENTRIES',
    'ARCHIVE_TOO_LARGE',
    'FILE_TOO_LARGE',
    'DESTINATION_EXISTS',
    'UNSAFE_ARCHIVE'
  ]
  return new ExtractionError(code, unsafeCodes.includes(code) ? `Unsafe archive: ${message}` : message)
}

function normalizeExtractionError(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof ExtractionError) return error
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return extractionError('EXTRACTION_CANCELLED', 'Extraction cancelled')
  }
  if (isWrongZipPasswordError(error)) {
    return extractionError('WRONG_ZIP_PASSWORD', 'Wrong ZIP password')
  }

  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : ''
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for extraction')
  }
  if (code === 'EFBIG') {
    return extractionError('DESTINATION_FILE_TOO_LARGE', 'The destination filesystem cannot store a file this large')
  }
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw extractionError('EXTRACTION_CANCELLED', 'Extraction cancelled')
}

function matchesSelectedEntry(entryPath: string, selectedEntries: Set<string> | null): boolean {
  if (!selectedEntries) return true

  const normalizedEntryPath = entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return Array.from(selectedEntries).some(selectedPath => {
    const normalizedSelectedPath = selectedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return normalizedEntryPath === normalizedSelectedPath || normalizedEntryPath.startsWith(`${normalizedSelectedPath}/`)
  })
}

function securityError(message: string, code: ExtractionErrorCode = 'UNSAFE_ARCHIVE'): ExtractionError {
  return extractionError(code, message)
}

function normalizeEntryPath(entryPath: string): string {
  if (!entryPath || entryPath.includes('\0')) {
    throw securityError('entry path is empty or contains a null byte')
  }

  const normalizedPath = entryPath.replace(/\\/g, '/')
  if (
    normalizedPath.startsWith('/') ||
    /^[a-zA-Z]:($|\/)/.test(normalizedPath) ||
    normalizedPath.split('/').some(part => part === '..')
  ) {
    throw securityError(`entry path escapes the destination: ${entryPath}`)
  }

  const safePath = path.posix.normalize(normalizedPath).replace(/^\.\//, '').replace(/\/+$/, '')
  if (!safePath || safePath === '.' || safePath.startsWith('../')) {
    throw securityError(`invalid entry path: ${entryPath}`)
  }

  return safePath
}

function resolveOutputPath(targetRoot: string, entryPath: string): string {
  const outputPath = path.resolve(targetRoot, ...entryPath.split('/'))
  const relativePath = path.relative(targetRoot, outputPath)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw securityError(`entry path resolves outside the destination: ${entryPath}`)
  }
  return outputPath
}

/**
 * A symlink entry stores its target as free-form text, so it needs its own
 * escape check: an absolute target reaches outside the destination outright,
 * and a relative one is resolved against the link's own directory (not
 * targetRoot, matching how the OS resolves it) before being range-checked.
 */
function assertSafeSymlinkTarget(targetRoot: string, outputPath: string, linkTarget: string): void {
  if (!linkTarget || linkTarget.includes('\0')) {
    throw securityError(`symlink has an empty or invalid target: ${outputPath}`)
  }

  const normalizedTarget = linkTarget.replace(/\\/g, '/')
  if (normalizedTarget.startsWith('/') || /^[a-zA-Z]:($|\/)/.test(normalizedTarget)) {
    throw securityError(`symlink target is an absolute path: ${linkTarget}`)
  }

  const resolvedTarget = path.resolve(path.dirname(outputPath), ...normalizedTarget.split('/'))
  const relativePath = path.relative(targetRoot, resolvedTarget)
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw securityError(`symlink target escapes the destination: ${linkTarget}`)
  }
}

async function lstatIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsPromises.lstat(filePath)
  } catch (error: any) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function assertSafeExistingPathComponents(absolutePath: string): Promise<void> {
  const parsedPath = path.parse(absolutePath)
  const parts = path.relative(parsedPath.root, absolutePath).split(path.sep).filter(Boolean)
  let currentPath = parsedPath.root

  for (const part of parts) {
    currentPath = path.join(currentPath, part)
    const stat = await lstatIfExists(currentPath)
    if (!stat) return
    if (stat.isSymbolicLink()) throw securityError(`destination contains a symbolic link: ${currentPath}`)
    if (!stat.isDirectory()) throw securityError(`destination path component is not a directory: ${currentPath}`)
  }
}

async function resolveThroughExistingAncestor(absolutePath: string): Promise<string> {
  const missingParts: string[] = []
  let existingPath = absolutePath
  let stat = await lstatIfExists(existingPath)

  while (!stat) {
    const parentPath = path.dirname(existingPath)
    if (parentPath === existingPath) throw securityError(`unable to resolve extraction target: ${absolutePath}`)
    missingParts.unshift(path.basename(existingPath))
    existingPath = parentPath
    stat = await lstatIfExists(existingPath)
  }

  return path.join(await fsPromises.realpath(existingPath), ...missingParts)
}

async function prepareTargetRoot(
  targetDir: string,
  transaction: ExtractionTransaction
): Promise<string> {
  const requestedTargetPath = path.resolve(targetDir)
  const requestedTargetStat = await lstatIfExists(requestedTargetPath)
  if (requestedTargetStat?.isSymbolicLink()) throw securityError('extraction target must not be a symbolic link')

  const targetPath = await resolveThroughExistingAncestor(requestedTargetPath)
  await assertSafeExistingPathComponents(targetPath)
  const missingDirectories: string[] = []
  let missingPath = targetPath
  let missingStat = await lstatIfExists(missingPath)
  while (!missingStat) {
    missingDirectories.unshift(missingPath)
    missingPath = path.dirname(missingPath)
    missingStat = await lstatIfExists(missingPath)
  }

  for (const directoryPath of missingDirectories) {
    try {
      await fsPromises.mkdir(directoryPath)
      transaction.recordDirectory(directoryPath)
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      const racedStat = await fsPromises.lstat(directoryPath)
      if (racedStat.isSymbolicLink() || !racedStat.isDirectory()) {
        throw securityError(`extraction target path is not a real directory: ${directoryPath}`)
      }
    }
  }
  await assertSafeExistingPathComponents(targetPath)

  const stat = await fsPromises.lstat(targetPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw securityError('extraction target must be a real directory')

  return fsPromises.realpath(targetPath)
}

async function assertSafeDestination(targetRoot: string, outputPath: string, isDirectory: boolean): Promise<void> {
  const relativePath = path.relative(targetRoot, outputPath)
  const parts = relativePath.split(path.sep).filter(Boolean)
  let currentPath = targetRoot

  for (let index = 0; index < parts.length - 1; index++) {
    currentPath = path.join(currentPath, parts[index])
    const stat = await lstatIfExists(currentPath)
    if (!stat) break
    if (stat.isSymbolicLink()) throw securityError(`destination parent is a symbolic link: ${currentPath}`)
    if (!stat.isDirectory()) throw securityError(`destination parent is not a directory: ${currentPath}`)
  }

  const existingDestination = await lstatIfExists(outputPath)
  if (!existingDestination) return
  if (existingDestination.isSymbolicLink()) throw securityError(`destination already contains a symbolic link: ${outputPath}`)
  if (!isDirectory || !existingDestination.isDirectory()) {
    throw securityError(`destination already exists: ${outputPath}`, 'DESTINATION_EXISTS')
  }
}

async function ensureSafeParentDirectories(
  targetRoot: string,
  outputPath: string,
  transaction: ExtractionTransaction
): Promise<void> {
  const relativeParentPath = path.relative(targetRoot, path.dirname(outputPath))
  const parts = relativeParentPath.split(path.sep).filter(Boolean)
  let currentPath = targetRoot

  for (const part of parts) {
    currentPath = path.join(currentPath, part)
    const stat = await lstatIfExists(currentPath)
    if (!stat) {
      await fsPromises.mkdir(currentPath)
      transaction.recordDirectory(currentPath)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw securityError(`cannot create files through destination path: ${currentPath}`)
    }
  }
}

async function ensureSafeDirectory(
  targetRoot: string,
  outputPath: string,
  transaction: ExtractionTransaction
): Promise<void> {
  await ensureSafeParentDirectories(targetRoot, outputPath, transaction)
  const stat = await lstatIfExists(outputPath)
  if (!stat) {
    await fsPromises.mkdir(outputPath)
    transaction.recordDirectory(outputPath)
    return
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw securityError(`cannot create directory at destination: ${outputPath}`)
  }
}

export function buildExtractionPlan(
  entries: ArchivePlanEntry[],
  targetRoot: string,
  selectedEntries: Set<string> | null,
  policy: ExtractionPolicy = DEFAULT_EXTRACTION_POLICY
): ExtractionPlan {
  if (entries.length > policy.maxEntries) {
    throw securityError(`archive contains more than ${policy.maxEntries.toLocaleString()} entries`, 'TOO_MANY_ENTRIES')
  }

  let selectedTotalBytes = 0
  const outputPaths = new Map<string, PlannedEntry>()
  const plannedEntries = entries.map(entry => {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw securityError(`entry has an invalid size: ${entry.archivePath}`)
    }

    const shouldExtract = matchesSelectedEntry(entry.archivePath, selectedEntries)
    // Unselected link entries are never read or written, so only entries
    // actually slated for extraction need a resolved, validated target.
    if (entry.isLink && shouldExtract && !entry.linkTarget) {
      throw securityError(`symbolic and hard link entries are not supported: ${entry.archivePath}`)
    }
    if (shouldExtract && entry.size > policy.maxFileBytes) {
      throw securityError(`entry exceeds the ${formatBinaryBytes(policy.maxFileBytes)} file size limit: ${entry.archivePath}`, 'FILE_TOO_LARGE')
    }
    if (shouldExtract) {
      selectedTotalBytes += entry.size
      if (selectedTotalBytes > policy.maxTotalBytes) {
        throw securityError(`archive exceeds the ${formatBinaryBytes(policy.maxTotalBytes)} extraction limit`, 'ARCHIVE_TOO_LARGE')
      }
    }

    const normalizedPath = normalizeEntryPath(entry.archivePath)
    const outputPath = resolveOutputPath(targetRoot, normalizedPath)
    if (entry.isLink && shouldExtract) assertSafeSymlinkTarget(targetRoot, outputPath, entry.linkTarget!)

    const plannedEntry: PlannedEntry = {
      archivePath: entry.archivePath,
      outputPath,
      isDirectory: entry.isDirectory,
      size: entry.size,
      shouldExtract,
      source: entry.source,
      isLink: entry.isLink,
      linkTarget: entry.linkTarget,
      mode: entry.mode
    }
    const outputKey = process.platform === 'win32' ? plannedEntry.outputPath.toLowerCase() : plannedEntry.outputPath
    if (outputPaths.has(outputKey)) throw securityError(`archive contains duplicate output paths: ${entry.archivePath}`)
    outputPaths.set(outputKey, plannedEntry)
    return plannedEntry
  })

  const fileOutputPaths = new Set(
    plannedEntries
      .filter(entry => !entry.isDirectory)
      .map(entry => process.platform === 'win32' ? entry.outputPath.toLowerCase() : entry.outputPath)
  )
  for (const entry of plannedEntries) {
    let parentPath = path.dirname(entry.outputPath)
    while (parentPath !== targetRoot) {
      const parentKey = process.platform === 'win32' ? parentPath.toLowerCase() : parentPath
      if (fileOutputPaths.has(parentKey)) {
        throw securityError(`archive entry has a file as its parent path: ${entry.archivePath}`)
      }
      parentPath = path.dirname(parentPath)
    }
  }

  return { entries: plannedEntries, selectedTotalBytes }
}

async function validateSelectedDestinations(targetRoot: string, entries: PlannedEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.shouldExtract) await assertSafeDestination(targetRoot, entry.outputPath, entry.isDirectory)
  }
}

// Only macOS has anywhere to put the metadata a sidecar carries; elsewhere the
// sidecars stay ordinary files, which is what every other unzip tool does.
const mergesAppleDouble = process.platform === 'darwin'

const execFileAsync = promisify(execFile)

// Finder's Archive Utility copies the archive's own quarantine flag onto
// everything it extracts, which is what makes Gatekeeper evaluate a freshly
// unzipped app on first open (and, as a side effect, register it with
// Launch Services right away instead of waiting on Finder's own icon pass).
// A plain filesystem writer has nothing to inherit that flag from, so it is
// restored by hand here, on the top level output items only - that already
// covers everything the user can double click, and touching every nested
// file in a large bundle would be a lot of `xattr` calls for no benefit.
const propagatesQuarantine = process.platform === 'darwin'
const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

async function readQuarantineAttributeHex(sourcePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xattr', ['-px', QUARANTINE_ATTRIBUTE, sourcePath])
    return stdout.replace(/\s/g, '') || null
  } catch {
    return null
  }
}

function topLevelSegment(entryPath: string): string {
  const normalizedPath = entryPath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.indexOf('/')
  return separatorIndex === -1 ? normalizedPath : normalizedPath.slice(0, separatorIndex)
}

async function propagateQuarantine(
  sourceArchivePath: string,
  targetRoot: string,
  topLevelNames: Iterable<string>
): Promise<void> {
  if (!propagatesQuarantine) return
  const hexValue = await readQuarantineAttributeHex(sourceArchivePath)
  if (!hexValue) return

  for (const name of topLevelNames) {
    await execFileAsync('xattr', ['-wx', QUARANTINE_ATTRIBUTE, hexValue, path.join(targetRoot, name)]).catch(() => undefined)
  }
}

// Windows creates symbolic links only for a process that is elevated or in
// developer mode. Leaving link entries rejected there keeps the clear "not
// supported" message instead of failing part way through with a privilege
// error that the user cannot act on.
const restoresSymbolicLinks = process.platform !== 'win32'

// Windows collapses a whole unix mode onto a single read-only flag, so
// restoring one buys nothing and costs a lot: an entry recorded as 0o444 would
// become an undeletable file that extraction rollback then leaves behind.
const restoresUnixMode = process.platform !== 'win32'

function zipUnixMode(entry: Entry): number {
  return entry.unixMode ?? ((entry.externalFileAttributes >>> 16) & 0xffff)
}

function isZipSymbolicLink(entry: Entry): boolean {
  return (zipUnixMode(entry) & 0o170000) === 0o120000
}

/**
 * The permission bits an entry should end up with, with setuid/setgid/sticky
 * stripped so no archive can grant them. Entries written by non-Unix tools
 * carry no mode at all and keep the restrictive mode they are created with,
 * which is why a zero result means "leave it alone" rather than "mode 0".
 */
function archivePermissions(unixMode: number): number | undefined {
  const permissions = unixMode & 0o777
  return permissions === 0 ? undefined : permissions
}

async function defaultAvailableBytes(targetRoot: string): Promise<bigint> {
  const stats = await fsPromises.statfs(targetRoot, { bigint: true })
  return stats.bavail * stats.bsize
}

async function createOwnedWebWriter(
  outputPath: string,
  transaction: ExtractionTransaction,
  consume: (byteLength: number) => void
): Promise<{ writable: WritableStream<Uint8Array>; close: () => Promise<void> }> {
  const handle = await fsPromises.open(outputPath, 'wx', 0o600)
  transaction.recordFile(outputPath)
  let closed = false

  const close = async () => {
    if (closed) return
    closed = true
    await handle.close().catch(() => undefined)
  }

  return {
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        consume(chunk.byteLength)
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null)
          if (bytesWritten === 0) throw new Error(`Unable to write extracted file: ${outputPath}`)
          offset += bytesWritten
        }
      },
      close,
      abort: close
    }),
    close
  }
}

async function createOwnedSymlink(
  outputPath: string,
  linkTarget: string,
  transaction: ExtractionTransaction
): Promise<void> {
  await fsPromises.symlink(linkTarget, outputPath)
  transaction.recordFile(outputPath)
}

async function openOwnedNodeWriteStream(
  outputPath: string,
  transaction: ExtractionTransaction
): Promise<{ handle: FileHandle; stream: fs.WriteStream }> {
  const handle = await fsPromises.open(outputPath, 'wx', 0o600)
  transaction.recordFile(outputPath)
  return { handle, stream: handle.createWriteStream() }
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
  const archivePath = terminalVolumePath(options.archivePath)
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
    if (ext === '.gz') {
      return await extractGzArchive(
        archivePath, targetRoot, startTime, policy, diskBudget,
        transaction, context.signal, onProgress
      )
    }
    throw new Error(`Unsupported archive format for extraction: ${ext}`)
  } catch (error) {
    await transaction.rollback()
    throw normalizeExtractionError(error, context.signal)
  }
}
