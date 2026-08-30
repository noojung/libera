import fs, { promises as fsPromises } from 'fs'
import path from 'path'
import { Readable, Writable } from 'stream'
import { pipeline } from 'stream/promises'
import { type FileEntry } from '@zip.js/zip.js'
import * as tar from 'tar'
import zlib from 'zlib'
import { MAX_ARCHIVE_ENTRIES, isWrongZipPasswordError } from './extractor'
import { openZipArchive } from './zip/fileReader'
import { canonicalArchivePath, isZipFormatExtension } from './archiveVolumes'
import { isSevenZipArchivePath } from './sevenZip/volumes'
import { Libera7zError } from '../lib/libera7z'
import { openLibera7zFile } from './sevenZip/node'

export const MAX_ARCHIVE_PREVIEW_BYTES = 1024 * 1024
export const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_PREVIEW_DIMENSION = 16_384
export const MAX_IMAGE_PREVIEW_PIXELS = 25_000_000

export type ArchivePreviewEncoding = 'utf-8' | 'utf-16le' | 'utf-16be'
export type ArchivePreviewMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type ArchivePreviewErrorCode =
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_NOT_PREVIEWABLE'
  | 'NOT_TEXT'
  | 'UNSUPPORTED_IMAGE'
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSIONS_TOO_LARGE'
  | 'PREVIEW_CANCELLED'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'

interface ArchivePreviewBaseResult {
  previewedBytes: number
  totalBytes: number | null
}

export interface ArchiveTextPreviewResult extends ArchivePreviewBaseResult {
  kind: 'text'
  text: string
  encoding: ArchivePreviewEncoding
  truncated: boolean
  rawBytes?: Uint8Array
}

export interface ArchiveImagePreviewResult extends ArchivePreviewBaseResult {
  kind: 'image'
  data: Uint8Array
  mediaType: ArchivePreviewMediaType
  width: number
  height: number
  rawBytes?: Uint8Array
}

export interface ArchiveBinaryPreviewResult extends ArchivePreviewBaseResult {
  kind: 'binary'
  rawBytes: Uint8Array
  truncated: boolean
}

export type ArchivePreviewResult = ArchiveTextPreviewResult | ArchiveImagePreviewResult | ArchiveBinaryPreviewResult

export interface ArchivePreviewRequestOptions {
  password?: string
  includeRawBytes?: boolean
}

export interface ArchivePreviewContext {
  signal?: AbortSignal
  /** Needed to read encrypted entries, and for a header-encrypted 7z to list at all. */
  password?: string
  includeRawBytes?: boolean
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

type CollectedPreviewKind =
  | { kind: 'text' }
  | { kind: 'image'; mediaType: ArchivePreviewMediaType }
  | { kind: 'unsupported-image' }

interface CollectedArchiveEntry {
  data: Buffer
  previewKind: CollectedPreviewKind
  truncated: boolean
  totalBytes: number | null
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

function hasBytes(data: Buffer, bytes: readonly number[], offset = 0): boolean {
  return data.length >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte)
}

function sniffPreviewKind(data: Buffer): CollectedPreviewKind | undefined {
  if (hasBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mediaType: 'image/png' }
  }
  if (hasBytes(data, [0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg' }
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    return { kind: 'image', mediaType: 'image/gif' }
  }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    return { kind: 'image', mediaType: 'image/webp' }
  }

  const isBmp = data.length >= 2 && data.toString('ascii', 0, 2) === 'BM'
  const isIco = hasBytes(data, [0x00, 0x00, 0x01, 0x00])
  const isTiff = hasBytes(data, [0x49, 0x49, 0x2a, 0x00]) || hasBytes(data, [0x4d, 0x4d, 0x00, 0x2a])
  const isoBrand = data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp'
    ? data.toString('ascii', 8, 12)
    : ''
  const isUnsupportedIsoImage = ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(isoBrand)
  if (isBmp || isIco || isTiff || isUnsupportedIsoImage) return { kind: 'unsupported-image' }
  return undefined
}

class PreviewCollector extends Writable {
  private readonly chunks: Buffer[] = []
  private pending = Buffer.alloc(0)
  private collectedBytes = 0
  private detectedKind: CollectedPreviewKind | null = null
  truncated = false

  get previewKind(): CollectedPreviewKind {
    return this.detectedKind || { kind: 'text' }
  }

  private get byteLimit(): number {
    return this.detectedKind?.kind === 'image' ? MAX_IMAGE_PREVIEW_BYTES : MAX_ARCHIVE_PREVIEW_BYTES
  }

  private collect(buffer: Buffer, callback: (error?: Error | null) => void): void {
    const remaining = this.byteLimit - this.collectedBytes
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

  _write(chunk: Buffer | Uint8Array, _: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.detectedKind) {
      this.collect(buffer, callback)
      return
    }

    const combined = this.pending.length > 0 ? Buffer.concat([this.pending, buffer]) : buffer
    const detectedKind = sniffPreviewKind(combined)
    if (!detectedKind && combined.length < 12) {
      this.pending = Buffer.from(combined)
      callback()
      return
    }

    this.detectedKind = detectedKind || { kind: 'text' }
    this.pending = Buffer.alloc(0)
    this.collect(combined, callback)
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.detectedKind || this.pending.length === 0) {
      if (!this.detectedKind) this.detectedKind = { kind: 'text' }
      callback()
      return
    }
    this.detectedKind = sniffPreviewKind(this.pending) || { kind: 'text' }
    const pending = this.pending
    this.pending = Buffer.alloc(0)
    this.collect(pending, callback)
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.collectedBytes)
  }
}

function collectedEntry(collector: PreviewCollector, totalBytes: number | null): CollectedArchiveEntry {
  return {
    data: collector.toBuffer(),
    previewKind: collector.previewKind,
    truncated: collector.truncated,
    totalBytes
  }
}

async function readZipEntry(
  archivePath: string,
  entryIndex: number,
  password: string | undefined,
  signal?: AbortSignal
): Promise<CollectedArchiveEntry> {
  const zip = await openZipArchive(archivePath, MAX_ARCHIVE_ENTRIES, { password })
  try {
    throwIfAborted(signal)
    if (zip.entries.length > MAX_ARCHIVE_ENTRIES) {
      throw previewError('ENTRY_NOT_PREVIEWABLE', 'Archive contains too many entries to preview safely')
    }
    const entry = zip.entries[entryIndex]
    if (!entry) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
    if (entry.directory) throw previewError('ENTRY_NOT_PREVIEWABLE', 'Directories cannot be previewed')
    // A ZIP central directory is readable without the password, so the entry
    // is listed and only its content needs one.
    if (entry.encrypted && password === undefined) {
      throw previewError('PASSWORD_REQUIRED', 'This archive entry needs a password')
    }

    const collector = new PreviewCollector()
    try {
      await (entry as FileEntry).getData(Writable.toWeb(collector), {
        password,
        signal,
        strictness: 'strict',
        checkCrc32: true,
        checkOverlappingEntry: true,
        useWebWorkers: false
      })
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
      }
      // ZipCrypto only carries a one-byte check, so a wrong password often
      // survives it and surfaces as a CRC mismatch on the garbage that follows.
      if (entry.encrypted && isWrongZipPasswordError(error)) {
        throw previewError('WRONG_PASSWORD', 'The archive password is incorrect')
      }
      if (collector.truncated) return collectedEntry(collector, Number(entry.uncompressedSize))
      throw error
    }
    return collectedEntry(collector, Number(entry.uncompressedSize))
  } finally {
    await zip.close()
  }
}

async function readTarEntry(
  archivePath: string,
  entryIndex: number,
  signal?: AbortSignal
): Promise<CollectedArchiveEntry> {
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
  const collector = new PreviewCollector()
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
      return collectedEntry(collector, totalBytes)
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
  return collectedEntry(collector, totalBytes)
}

async function readGzEntry(
  archivePath: string,
  entryIndex: number,
  signal?: AbortSignal
): Promise<CollectedArchiveEntry> {
  if (entryIndex !== 0) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
  const collector = new PreviewCollector()
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
  return collectedEntry(collector, null)
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

function invalidImage(message: string): ArchivePreviewError {
  return previewError('INVALID_IMAGE', message)
}

function parsePngDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.length < 24 ||
    !hasBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    data.toString('ascii', 12, 16) !== 'IHDR'
  ) throw invalidImage('PNG image has an invalid header')
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

function parseGifDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 10 || !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    throw invalidImage('GIF image has an invalid header')
  }
  return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

function parseJpegDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || !hasBytes(data, [0xff, 0xd8, 0xff])) {
    throw invalidImage('JPEG image has an invalid header')
  }
  let offset = 2
  while (offset < data.length) {
    while (offset < data.length && data[offset] === 0xff) offset++
    if (offset >= data.length) break
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 2 > data.length) break
    const segmentLength = data.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > data.length) {
      throw invalidImage('JPEG image contains an invalid segment')
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) throw invalidImage('JPEG image has an invalid frame header')
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5)
      }
    }
    offset += segmentLength
  }
  throw invalidImage('JPEG image dimensions could not be read')
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)
}

function parseWebpDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.length < 20 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP'
  ) throw invalidImage('WebP image has an invalid header')

  let offset = 12
  while (offset + 8 <= data.length) {
    const chunkType = data.toString('ascii', offset, offset + 4)
    const chunkSize = data.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize
    if (chunkEnd > data.length) throw invalidImage('WebP image contains an invalid chunk')

    if (chunkType === 'VP8X' && chunkSize >= 10) {
      return {
        width: readUInt24LE(data, chunkStart + 4) + 1,
        height: readUInt24LE(data, chunkStart + 7) + 1
      }
    }
    if (chunkType === 'VP8L' && chunkSize >= 5 && data[chunkStart] === 0x2f) {
      const bits = data.readUInt32LE(chunkStart + 1)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1
      }
    }
    if (
      chunkType === 'VP8 ' &&
      chunkSize >= 10 &&
      hasBytes(data, [0x9d, 0x01, 0x2a], chunkStart + 3)
    ) {
      return {
        width: data.readUInt16LE(chunkStart + 6) & 0x3fff,
        height: data.readUInt16LE(chunkStart + 8) & 0x3fff
      }
    }
    offset = chunkEnd + (chunkSize % 2)
  }
  throw invalidImage('WebP image dimensions could not be read')
}

function parseImageDimensions(data: Buffer, mediaType: ArchivePreviewMediaType): { width: number; height: number } {
  if (mediaType === 'image/png') return parsePngDimensions(data)
  if (mediaType === 'image/jpeg') return parseJpegDimensions(data)
  if (mediaType === 'image/gif') return parseGifDimensions(data)
  return parseWebpDimensions(data)
}

function validateImageDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalidImage('Image dimensions are invalid')
  }
  if (
    width > MAX_IMAGE_PREVIEW_DIMENSION ||
    height > MAX_IMAGE_PREVIEW_DIMENSION ||
    width * height > MAX_IMAGE_PREVIEW_PIXELS
  ) {
    throw previewError('IMAGE_DIMENSIONS_TOO_LARGE', 'Image dimensions exceed the safe preview limit')
  }
}

/** Reads one entry with Libera7z, decoding only its containing solid folder. */
async function readSevenZipEntry(
  archivePath: string,
  entryIndex: number,
  password: string | undefined,
  signal?: AbortSignal
): Promise<CollectedArchiveEntry> {
  let archive
  try {
    archive = await openLibera7zFile(archivePath, {
      signal,
      maxEntries: MAX_ARCHIVE_ENTRIES,
      password
    })
  } catch (error) {
    if (error instanceof Libera7zError && error.code === 'CANCELLED') {
      throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
    }
    if (error instanceof Libera7zError && error.code === 'PASSWORD_REQUIRED') {
      throw previewError('PASSWORD_REQUIRED', 'This archive needs a password')
    }
    if (error instanceof Libera7zError && error.code === 'WRONG_PASSWORD') {
      throw previewError('WRONG_PASSWORD', 'The archive password is incorrect')
    }
    throw error
  }
  try {
    const entry = archive.entries[entryIndex]
    if (!entry) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
    if (entry.isDirectory) throw previewError('ENTRY_NOT_PREVIEWABLE', 'Directories cannot be previewed')
    if (entry.isSymlink) throw previewError('ENTRY_NOT_PREVIEWABLE', 'Symbolic links cannot be previewed')
    if (archive.entries.filter(other => other.path === entry.path).length > 1) {
      throw previewError('ENTRY_NOT_PREVIEWABLE', 'Archive contains duplicate entry paths')
    }
    const collector = new PreviewCollector()
    try {
      await pipeline(
        Readable.fromWeb(archive.openEntry(entryIndex, { signal }) as import('stream/web').ReadableStream),
        collector
      )
    } catch (error) {
      if (!collector.truncated) {
        if (error instanceof Libera7zError && error.code === 'CANCELLED') {
          throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
        }
        if (error instanceof Libera7zError && error.code === 'PASSWORD_REQUIRED') {
          throw previewError('PASSWORD_REQUIRED', 'This entry needs a password to preview')
        }
        if (error instanceof Libera7zError && error.code === 'WRONG_PASSWORD') {
          throw previewError('WRONG_PASSWORD', 'The archive password is incorrect')
        }
        if (isAbortError(error) || signal?.aborted) {
          throw previewError('PREVIEW_CANCELLED', 'Archive preview was cancelled')
        }
        throw error
      }
    }
    const totalBytes = Number(entry.size)
    return collectedEntry(collector, Number.isSafeInteger(totalBytes) ? totalBytes : null)
  } finally {
    await archive.close()
  }
}

export async function previewArchiveEntry(
  inputPath: string,
  entryId: string,
  context: ArchivePreviewContext = {}
): Promise<ArchivePreviewResult> {
  throwIfAborted(context.signal)
  const match = /^entry-(\d+)$/.exec(entryId)
  if (!match) throw previewError('ENTRY_NOT_FOUND', 'Archive entry was not found')
  const entryIndex = Number(match[1])
  // Entry ids index the terminal volume's central directory, so a numbered
  // volume has to resolve to the same archive the inspector listed.
  const archivePath = canonicalArchivePath(inputPath)
  const stat = await fsPromises.stat(archivePath).catch(() => null)
  if (!stat) throw new Error(`File does not exist: ${archivePath}`)
  if (!stat.isFile()) throw new Error('Archive preview requires a file')

  const ext = path.extname(archivePath).toLowerCase()
  const fullExt = archivePath.toLowerCase()
  let preview: CollectedArchiveEntry
  if (isZipFormatExtension(ext)) {
    preview = await readZipEntry(archivePath, entryIndex, context.password, context.signal)
  } else if (ext === '.tar' || fullExt.endsWith('.tgz') || fullExt.endsWith('.tar.gz')) {
    preview = await readTarEntry(archivePath, entryIndex, context.signal)
  } else if (isSevenZipArchivePath(archivePath)) {
    preview = await readSevenZipEntry(archivePath, entryIndex, context.password, context.signal)
  } else if (ext === '.gz') {
    preview = await readGzEntry(archivePath, entryIndex, context.signal)
  } else {
    throw new Error(`Unsupported archive format: ${ext}`)
  }

  const truncated = preview.truncated || (preview.totalBytes !== null && preview.totalBytes > preview.data.length)
  if (preview.previewKind.kind === 'unsupported-image') {
    if (context.includeRawBytes) {
      return {
        kind: 'binary',
        rawBytes: Uint8Array.from(preview.data.subarray(0, MAX_ARCHIVE_PREVIEW_BYTES)),
        truncated,
        previewedBytes: Math.min(preview.data.length, MAX_ARCHIVE_PREVIEW_BYTES),
        totalBytes: preview.totalBytes
      }
    }
    throw previewError('UNSUPPORTED_IMAGE', 'This image format is not supported for preview')
  }
  if (preview.previewKind.kind === 'image') {
    if (truncated) throw previewError('IMAGE_TOO_LARGE', 'Image exceeds the 10 MiB preview limit')
    const { width, height } = parseImageDimensions(preview.data, preview.previewKind.mediaType)
    validateImageDimensions(width, height)
    return {
      kind: 'image',
      data: Uint8Array.from(preview.data),
      mediaType: preview.previewKind.mediaType,
      width,
      height,
      previewedBytes: preview.data.length,
      totalBytes: preview.totalBytes
    }
  }

  let decoded: ReturnType<typeof decodeText>
  try {
    decoded = decodeText(preview.data, truncated)
  } catch (error) {
    if (!context.includeRawBytes || !(error instanceof ArchivePreviewError) || error.code !== 'NOT_TEXT') throw error
    return {
      kind: 'binary',
      rawBytes: Uint8Array.from(preview.data),
      truncated,
      previewedBytes: preview.data.length,
      totalBytes: preview.totalBytes
    }
  }
  return {
    kind: 'text',
    ...decoded,
    truncated,
    previewedBytes: preview.data.length,
    totalBytes: preview.totalBytes,
    ...(context.includeRawBytes ? { rawBytes: Uint8Array.from(preview.data) } : {})
  }
}
