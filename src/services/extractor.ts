import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import zlib from 'zlib'
import type { ProgressCallback } from './compressor'

export interface ExtractionOptions {
  archivePath: string
  targetDir: string
  selectedEntries?: string[]
  password?: string
}

interface PlannedEntry {
  archivePath: string
  outputPath: string
  isDirectory: boolean
  size: number
  shouldExtract: boolean
  source?: any
}

export const WRONG_ZIP_PASSWORD_ERROR_CODE = 'WRONG_ZIP_PASSWORD'
export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz'] as const
export const MAX_ARCHIVE_ENTRIES = 10_000
export const MAX_TOTAL_EXTRACTED_BYTES = 1024 * 1024 * 1024
export const MAX_FILE_EXTRACTED_BYTES = 512 * 1024 * 1024

export function isSupportedArchivePath(archivePath: string): boolean {
  const normalizedPath = archivePath.toLowerCase()
  return SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => normalizedPath.endsWith(extension))
}

export function isWrongZipPasswordError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Wrong Password')
}

function createWrongZipPasswordError(): Error & { code: string } {
  const error = new Error('Wrong ZIP password') as Error & { code: string }
  error.code = WRONG_ZIP_PASSWORD_ERROR_CODE
  return error
}

function matchesSelectedEntry(entryPath: string, selectedEntries: Set<string> | null): boolean {
  if (!selectedEntries) return true

  const normalizedEntryPath = entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return Array.from(selectedEntries).some(selectedPath => {
    const normalizedSelectedPath = selectedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return normalizedEntryPath === normalizedSelectedPath || normalizedEntryPath.startsWith(`${normalizedSelectedPath}/`)
  })
}

function securityError(message: string): Error {
  return new Error(`Unsafe archive: ${message}`)
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
    if (stat.isSymbolicLink()) {
      throw securityError(`destination contains a symbolic link: ${currentPath}`)
    }
    if (!stat.isDirectory()) {
      throw securityError(`destination path component is not a directory: ${currentPath}`)
    }
  }
}

async function resolveThroughExistingAncestor(absolutePath: string): Promise<string> {
  const missingParts: string[] = []
  let existingPath = absolutePath
  let stat = await lstatIfExists(existingPath)

  while (!stat) {
    const parentPath = path.dirname(existingPath)
    if (parentPath === existingPath) {
      throw securityError(`unable to resolve extraction target: ${absolutePath}`)
    }
    missingParts.unshift(path.basename(existingPath))
    existingPath = parentPath
    stat = await lstatIfExists(existingPath)
  }

  return path.join(await fsPromises.realpath(existingPath), ...missingParts)
}

async function prepareTargetRoot(targetDir: string): Promise<string> {
  const requestedTargetPath = path.resolve(targetDir)
  const requestedTargetStat = await lstatIfExists(requestedTargetPath)
  if (requestedTargetStat?.isSymbolicLink()) {
    throw securityError('extraction target must not be a symbolic link')
  }

  const targetPath = await resolveThroughExistingAncestor(requestedTargetPath)
  await assertSafeExistingPathComponents(targetPath)
  await fsPromises.mkdir(targetPath, { recursive: true })
  await assertSafeExistingPathComponents(targetPath)

  const stat = await fsPromises.lstat(targetPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw securityError('extraction target must be a real directory')
  }

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
    if (stat.isSymbolicLink()) {
      throw securityError(`destination parent is a symbolic link: ${currentPath}`)
    }
    if (!stat.isDirectory()) {
      throw securityError(`destination parent is not a directory: ${currentPath}`)
    }
  }

  const existingDestination = await lstatIfExists(outputPath)
  if (!existingDestination) return
  if (existingDestination.isSymbolicLink()) {
    throw securityError(`destination already contains a symbolic link: ${outputPath}`)
  }
  if (!isDirectory || !existingDestination.isDirectory()) {
    throw securityError(`destination already exists: ${outputPath}`)
  }
}

async function ensureSafeParentDirectories(targetRoot: string, outputPath: string): Promise<void> {
  const relativeParentPath = path.relative(targetRoot, path.dirname(outputPath))
  const parts = relativeParentPath.split(path.sep).filter(Boolean)
  let currentPath = targetRoot

  for (const part of parts) {
    currentPath = path.join(currentPath, part)
    const stat = await lstatIfExists(currentPath)
    if (!stat) {
      await fsPromises.mkdir(currentPath)
      continue
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw securityError(`cannot create files through destination path: ${currentPath}`)
    }
  }
}

async function ensureSafeDirectory(targetRoot: string, outputPath: string): Promise<void> {
  await ensureSafeParentDirectories(targetRoot, outputPath)
  const stat = await lstatIfExists(outputPath)
  if (!stat) {
    await fsPromises.mkdir(outputPath)
    return
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw securityError(`cannot create directory at destination: ${outputPath}`)
  }
}

function buildExtractionPlan(
  entries: Array<{ archivePath: string; isDirectory: boolean; size: number; isLink?: boolean; source?: any }>,
  targetRoot: string,
  selectedEntries: Set<string> | null
): PlannedEntry[] {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw securityError(`archive contains more than ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entries`)
  }

  let totalSize = 0
  const outputPaths = new Map<string, PlannedEntry>()
  const plannedEntries = entries.map(entry => {
    if (entry.isLink) {
      throw securityError(`symbolic and hard link entries are not supported: ${entry.archivePath}`)
    }
    if (entry.size < 0 || entry.size > MAX_FILE_EXTRACTED_BYTES) {
      throw securityError(`entry exceeds the ${MAX_FILE_EXTRACTED_BYTES / 1024 / 1024} MiB file size limit: ${entry.archivePath}`)
    }

    totalSize += entry.size
    if (totalSize > MAX_TOTAL_EXTRACTED_BYTES) {
      throw securityError(`archive exceeds the ${MAX_TOTAL_EXTRACTED_BYTES / 1024 / 1024 / 1024} GiB extraction limit`)
    }

    const normalizedPath = normalizeEntryPath(entry.archivePath)
    const plannedEntry: PlannedEntry = {
      archivePath: entry.archivePath,
      outputPath: resolveOutputPath(targetRoot, normalizedPath),
      isDirectory: entry.isDirectory,
      size: entry.size,
      shouldExtract: matchesSelectedEntry(entry.archivePath, selectedEntries),
      source: entry.source
    }
    if (outputPaths.has(plannedEntry.outputPath)) {
      throw securityError(`archive contains duplicate output paths: ${entry.archivePath}`)
    }
    outputPaths.set(plannedEntry.outputPath, plannedEntry)
    return plannedEntry
  })

  const fileOutputPaths = new Set(plannedEntries.filter(entry => !entry.isDirectory).map(entry => entry.outputPath))
  for (const entry of plannedEntries) {
    let parentPath = path.dirname(entry.outputPath)
    while (parentPath !== targetRoot) {
      if (fileOutputPaths.has(parentPath)) {
        throw securityError(`archive entry has a file as its parent path: ${entry.archivePath}`)
      }
      parentPath = path.dirname(parentPath)
    }
  }

  return plannedEntries
}

async function validateSelectedDestinations(targetRoot: string, entries: PlannedEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.shouldExtract) {
      await assertSafeDestination(targetRoot, entry.outputPath, entry.isDirectory)
    }
  }
}

function isZipSymbolicLink(entry: any): boolean {
  const unixFileType = (Number(entry.attr) >>> 16) & 0o170000
  return unixFileType === 0o120000
}

async function extractZipArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  password: string | undefined,
  startTime: number,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const zip = new AdmZip(archivePath)
  const zipEntries = (zip as any).getEntries(password) as any[]
  const selectedPaths = selectedEntries ? new Set(selectedEntries) : null
  const plan = buildExtractionPlan(
    zipEntries.map(entry => ({
      archivePath: entry.entryName,
      isDirectory: entry.isDirectory,
      size: entry.isDirectory ? 0 : Number(entry.header.size),
      isLink: isZipSymbolicLink(entry),
      source: entry
    })),
    targetRoot,
    selectedPaths
  )
  await validateSelectedDestinations(targetRoot, plan)

  const filesToExtract = plan.filter(entry => entry.shouldExtract && !entry.isDirectory)
  let extractedCount = 0
  for (const entry of plan.filter(entry => entry.shouldExtract)) {
    if (entry.isDirectory) {
      await ensureSafeDirectory(targetRoot, entry.outputPath)
      continue
    }

    await ensureSafeParentDirectories(targetRoot, entry.outputPath)
    const contents = zip.readFile(entry.source, password)
    if (!contents) throw new Error(`Unable to read ZIP entry: ${entry.archivePath}`)
    if (contents.length > MAX_FILE_EXTRACTED_BYTES) {
      throw securityError(`entry exceeds the ${MAX_FILE_EXTRACTED_BYTES / 1024 / 1024} MiB file size limit: ${entry.archivePath}`)
    }
    await fsPromises.writeFile(entry.outputPath, contents, { flag: 'wx', mode: 0o600 })
    extractedCount++

    onProgress?.({
      processedBytes: extractedCount,
      totalBytes: filesToExtract.length,
      percent: filesToExtract.length === 0 ? 100 : Math.round((extractedCount / filesToExtract.length) * 100),
      phase: 'processing',
      currentFile: entry.archivePath
    })
  }

  return { targetDir: targetRoot, extractedCount, durationMs: Date.now() - startTime }
}

async function listTarEntries(archivePath: string): Promise<Array<{ archivePath: string; isDirectory: boolean; size: number; isLink: boolean }>> {
  const entries: Array<{ archivePath: string; isDirectory: boolean; size: number; isLink: boolean }> = []
  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry: any) => {
      const allowedTypes = new Set(['File', 'OldFile', 'Directory'])
      entries.push({
        archivePath: entry.path,
        isDirectory: entry.type === 'Directory',
        size: Number(entry.size || 0),
        isLink: !allowedTypes.has(entry.type)
      })
    }
  })
  return entries
}

async function extractTarArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  startTime: number,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const selectedPaths = selectedEntries ? new Set(selectedEntries) : null
  const plan = buildExtractionPlan(await listTarEntries(archivePath), targetRoot, selectedPaths)
  await validateSelectedDestinations(targetRoot, plan)

  const plannedEntries = new Map(plan.map(entry => [entry.archivePath, entry]))
  const extractableEntries = plan.filter(entry => entry.shouldExtract)
  let processedEntries = 0

  await tar.x({
    file: archivePath,
    cwd: targetRoot,
    strict: true,
    keep: true,
    preservePaths: false,
    preserveOwner: false,
    filter: (entryPath: string) => plannedEntries.get(entryPath)?.shouldExtract === true,
    onentry: (entry: any) => {
      processedEntries++
      onProgress?.({
        processedBytes: processedEntries,
        totalBytes: extractableEntries.length,
        percent: extractableEntries.length === 0 ? 100 : Math.min(100, Math.round((processedEntries / extractableEntries.length) * 100)),
        phase: 'processing',
        currentFile: entry.path
      })
    }
  })

  return {
    targetDir: targetRoot,
    extractedCount: extractableEntries.filter(entry => !entry.isDirectory).length,
    durationMs: Date.now() - startTime
  }
}

async function extractGzArchive(
  archivePath: string,
  targetRoot: string,
  startTime: number,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const outputName = normalizeEntryPath(path.basename(archivePath, '.gz'))
  const outputPath = resolveOutputPath(targetRoot, outputName)
  await assertSafeDestination(targetRoot, outputPath, false)
  await ensureSafeParentDirectories(targetRoot, outputPath)

  let extractedBytes = 0
  const byteLimit = new Transform({
    transform(chunk, _, callback) {
      extractedBytes += chunk.length
      if (extractedBytes > MAX_FILE_EXTRACTED_BYTES || extractedBytes > MAX_TOTAL_EXTRACTED_BYTES) {
        callback(securityError(`GZ archive exceeds the ${MAX_FILE_EXTRACTED_BYTES / 1024 / 1024} MiB file size limit`))
        return
      }
      onProgress?.({
        processedBytes: extractedBytes,
        totalBytes: MAX_FILE_EXTRACTED_BYTES,
        percent: Math.min(99, Math.round((extractedBytes / MAX_FILE_EXTRACTED_BYTES) * 100)),
        phase: 'processing',
        currentFile: outputName
      })
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      fs.createReadStream(archivePath),
      zlib.createGunzip(),
      byteLimit,
      fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    )
  } catch (error) {
    await fsPromises.unlink(outputPath).catch(() => undefined)
    throw error
  }

  onProgress?.({
    processedBytes: extractedBytes,
    totalBytes: extractedBytes,
    percent: 100,
    phase: 'complete',
    currentFile: outputName
  })
  return { targetDir: targetRoot, extractedCount: 1, durationMs: Date.now() - startTime }
}

export async function extractArchive(
  options: ExtractionOptions,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const startTime = Date.now()
  const { archivePath, targetDir, selectedEntries, password } = options

  const archiveStat = await fsPromises.lstat(archivePath).catch(() => null)
  if (!archiveStat) throw new Error(`Archive file does not exist: ${archivePath}`)
  if (!archiveStat.isFile()) throw new Error('Extraction requires an archive file, not a folder')
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(`Unsupported archive format for extraction: ${path.extname(archivePath).toLowerCase()}`)
  }

  const targetRoot = await prepareTargetRoot(targetDir)
  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()

  try {
    if (ext === '.zip') {
      return await extractZipArchive(archivePath, targetRoot, selectedEntries, password, startTime, onProgress)
    }
    if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
      return await extractTarArchive(archivePath, targetRoot, selectedEntries, startTime, onProgress)
    }
    if (ext === '.gz') {
      return await extractGzArchive(archivePath, targetRoot, startTime, onProgress)
    }
    throw new Error(`Unsupported archive format for extraction: ${ext}`)
  } catch (error) {
    throw isWrongZipPasswordError(error) ? createWrongZipPasswordError() : error
  }
}
