import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { Writable } from 'stream'
import { pipeline } from 'stream/promises'
import { ERR_ENCRYPTED, type FileEntry } from '@zip.js/zip.js'
import * as tar from 'tar'
import zlib from 'zlib'
import { MAX_ARCHIVE_ENTRIES } from './extractor'
import { openZipArchive } from './zipFileReader'

export const MAX_ARCHIVE_PREVIEW_BYTES = 1024 * 1024

export type ArchivePreviewEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'
export type ArchivePreviewErrorCode =
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_PREVIEWABLE'
  | 'ENCRYPTED_PREVIEW_UNSUPPORTED'
  | 'NOT_TEXT'
  | 'PREVIEW_CANCELLED'

export interface ArchivePreviewResult {
  text: string
  encoding: ArchivePreviewEncoding
  truncated: boolean
  previewedBytes: number
  totalBytes: number | null
}

export interface ArchivePreviewContext {
  signal?: AbortSignal
}

export class ArchivePreviewError extends Error {
  constructor(public readonly code: ArchivePreviewErrorCode, message: string) {
    super(message)
    this.name = 'ArchivePreviewError'
  }
}

class PreviewLimitReached extends Error {
  constructor() {
    super('Archive preview byte limit reached')
    this.name = 'PreviewLimitReached'
  }
}

function previewError(code: ArchivePreviewErrorCode, message: string): ArchivePreviewError {
  return new ArchivePreviewError(code, message)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    (error as Error & { code?: string }).code === 'ABORT_ERR'
  )
}

class PreviewCollector extends Writable {
  private readonly chunks: Buffer[] = []
  private collectedBytes = 0
  truncated = false

  constructor(private readonly limit: number) {
    super()
  }

  _write(chunk: Buffer | Uint8Array, _: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = this.limit - this.collectedBytes
    if (remaining > 0) {
      const slice = buffer.subarray(0, remaining)
      this.chunks.push(Buffer.from(slice))
      this.collectedBytes += slice.length
    }

    if (buffer.length > remaining) {
      this.truncated = true
      callback(new PreviewLimitReached())
      return
    }
    callback()
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.collectedBytes)
  }
}

async function readZipEntry(
  archivePath: string,
  entryIndex: number,
  signal?: AbortSignal
): Promise<{ data: Buffer; truncated: boolean; totalBytes: number }> {
  const zip = await openZipArchive(archivePath, MAX_ARCHIVE_ENTRIES)
  try {
    throwIfAborted(signal)
    if (zip.entries.length > MAX_ARCHIVE_ENTRIES) {
      throw previewError('ENTRY_NOT_PREVIEWABLE', 'Archive contains too many entries to preview safely')
    }
    const entry = zip.entries[entryIndex]
    if (!entry) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
    if (entry.directory) throw previewError('ENTRY_NOT_PREVIEWABLE', 'Directories cannot be previewed')
    if (entry.encrypted) {
      throw previewError('ENCRYPTED_PREVIEW_UNSUPPORTED', 'Encrypted ZIP entries cannot be previewed')
    }

    const collector = new PreviewCollector(MAX_ARCHIVE_PREVIEW_BYTES)
    try {
      await (entry as FileEntry).getData(Writable.toWeb(collector), {
        signal,
        strictness: 'strict',
        checkCrc32: true,
        checkOverlappingEntry: true,
        useWebWorkers: false
      })
    } catch (error) {
      if (collector.truncated) {
        return { data: collector.toBuffer(), truncated: true, totalBytes: Number(entry.uncompressedSize) }
      }
      if (isAbortError(error) || signal?.aborted) {
        throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
      }
      if (error instanceof Error && error.message === ERR_ENCRYPTED) {
        throw previewError('ENCRYPTED_PREVIEW_UNSUPPORTED', 'Encrypted ZIP entries cannot be previewed')
      }
      throw error
    }

    return {
      data: collector.toBuffer(),
      truncated: collector.truncated,
      totalBytes: Number(entry.uncompressedSize)
    }
  } finally {
    await zip.close()
  }
}

async function readTarEntry(
  archivePath: string,
  entryIndex: number,
  signal?: AbortSignal
): Promise<{ data: Buffer; truncated: boolean; totalBytes: number }> {
  let entryFound = false
  let entryType: string | undefined
  let totalBytes = 0
  let currentIndex = 0
  let limitError: ArchivePreviewError | undefined
  let selectedEntry: (NodeJS.ReadableStream & { destroy(error?: Error): void }) | undefined
  const listingReference: { current?: { abort(error: Error): void } } = {}
  let resolveEntryComplete!: () => void
  let rejectEntryComplete!: (error: unknown) => void
  const entryComplete = new Promise<void>((resolve, reject) => {
    resolveEntryComplete = resolve
    rejectEntryComplete = reject
  })
  const collector = new PreviewCollector(MAX_ARCHIVE_PREVIEW_BYTES)
  const listing = tar.t({
    strict: true,
    noResume: true,
    onentry: (entry: any) => {
      if (currentIndex >= MAX_ARCHIVE_ENTRIES) {
        limitError = previewError('ENTRY_NOT_PREVIEWABLE', 'Archive contains too many entries to preview safely')
        rejectEntryComplete(limitError)
        listingReference.current?.abort(limitError)
        return
      }
      if (currentIndex++ !== entryIndex) {
        entry.resume()
        return
      }
      entryFound = true
      entryType = entry.type
      totalBytes = Number(entry.size || 0)
      selectedEntry = entry
      entry.on('error', rejectEntryComplete)
      collector.on('finish', resolveEntryComplete)
      collector.on('error', rejectEntryComplete)
      entry.pipe(collector)
    }
  }) as unknown as NodeJS.ReadWriteStream & { abort(error: Error): void }
  listingReference.current = listing
  listing.on('end', () => {
    if (!entryFound) resolveEntryComplete()
  })

  try {
    await Promise.all([
      pipeline(fs.createReadStream(archivePath), listing, { signal }),
      entryComplete
    ])
  } catch (error) {
    if (limitError) throw limitError
    if (collector.truncated) {
      selectedEntry?.destroy()
      listing.abort(new PreviewLimitReached())
      return { data: collector.toBuffer(), truncated: true, totalBytes }
    }
    if (isAbortError(error) || signal?.aborted) {
      throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
    }
    throw error
  }

  if (!entryFound) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
  if (!['File', 'OldFile', 'ContiguousFile'].includes(entryType || '')) {
    throw previewError('ENTRY_NOT_PREVIEWABLE', 'Only regular files can be previewed')
  }
  return { data: collector.toBuffer(), truncated: collector.truncated, totalBytes }
}

async function readGzEntry(
  archivePath: string,
  entryIndex: number,
  signal?: AbortSignal
): Promise<{ data: Buffer; truncated: boolean; totalBytes: null }> {
  if (entryIndex !== 0) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
  const collector = new PreviewCollector(MAX_ARCHIVE_PREVIEW_BYTES)
  try {
    await pipeline(
      fs.createReadStream(archivePath),
      zlib.createGunzip(),
      collector,
      { signal }
    )
  } catch (error) {
    if (!collector.truncated) {
      if (isAbortError(error) || signal?.aborted) {
        throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
      }
      throw error
    }
  }
  return { data: collector.toBuffer(), truncated: collector.truncated, totalBytes: null }
}

function decodeText(data: Buffer, truncated: boolean): { text: string; encoding: ArchivePreviewEncoding } {
  let bytes = data
  let encoding: ArchivePreviewEncoding = 'utf-8'
  if (data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    bytes = data.subarray(3)
  } else if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    bytes = data.subarray(2)
    encoding = 'utf-16le'
  } else if (data.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    bytes = data.subarray(2)
    encoding = 'utf-16be'
  }

  if (encoding === 'utf-8' && bytes.includes(0)) {
    throw previewError('NOT_TEXT', 'Archive entry appears to contain binary data')
  }

  let text: string | undefined
  const maximumTrailingBytes = truncated ? (encoding === 'utf-8' ? 3 : 1) : 0
  for (let trailingBytes = 0; trailingBytes <= maximumTrailingBytes; trailingBytes++) {
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(
        trailingBytes > 0 ? bytes.subarray(0, -trailingBytes) : bytes
      )
      break
    } catch {
      // A byte-limited preview can end in the middle of the final character.
    }
  }
  if (text === undefined) throw previewError('NOT_TEXT', 'Archive entry is not valid supported text')

  let suspiciousControlCharacters = 0
  let characterCount = 0
  for (const character of text) {
    characterCount++
    const codePoint = character.codePointAt(0) || 0
    if (codePoint < 32 && !['\t', '\n', '\r', '\f'].includes(character)) suspiciousControlCharacters++
  }
  if (characterCount > 0 && suspiciousControlCharacters / characterCount > 0.01) {
    throw previewError('NOT_TEXT', 'Archive entry appears to contain binary data')
  }

  return { text, encoding }
}

export async function previewArchiveEntry(
  archivePath: string,
  entryId: string,
  context: ArchivePreviewContext = {}
): Promise<ArchivePreviewResult> {
  throwIfAborted(context.signal)
  const match = /^entry-(\d+)$/.exec(entryId)
  if (!match) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
  const entryIndex = Number(match[1])
  const stat = await fsPromises.stat(archivePath).catch(() => null)
  if (!stat) throw new Error(`File does not exist: ${archivePath}`)
  if (!stat.isFile()) throw new Error('Archive preview requires a file')

  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()
  let preview: { data: Buffer; truncated: boolean; totalBytes: number | null }
  if (ext === '.zip') {
    preview = await readZipEntry(archivePath, entryIndex, context.signal)
  } else if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
    preview = await readTarEntry(archivePath, entryIndex, context.signal)
  } else if (ext === '.gz') {
    preview = await readGzEntry(archivePath, entryIndex, context.signal)
  } else {
    throw new Error(`Unsupported archive format: ${ext}`)
  }

  const decoded = decodeText(preview.data, preview.truncated)
  return {
    ...decoded,
    truncated: preview.truncated || (preview.totalBytes !== null && preview.totalBytes > preview.data.length),
    previewedBytes: preview.data.length,
    totalBytes: preview.totalBytes
  }
}
