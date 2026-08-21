import { ByteReader, ByteWriter, bitVector, concatBytes, readBitVector, uint64ToSafeNumber } from './binary'
import { Crc32, crc32 } from './crc32'
import { Libera7zError, invalidArchive, throwIfCancelled, unsupportedFeature } from './errors'
import { type RandomAccessSource, type SeekableSink, readExactly, readableFromGenerator } from './io'
import { LzmaDecoder, type LzmaEncoderOptions } from './lzma'
import {
  LZMA2_ENCODE_CHUNK_SIZE,
  decodeLzma2,
  dictionaryPropertyForSize,
  dictionarySizeFromProperty,
  encodeLzma2Block
} from './lzma2'

const SIGNATURE = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)
const SIGNATURE_HEADER_SIZE = 32
const MAX_ENCODED_HEADER_SIZE = 64 * 1024 * 1024
const COPY_METHOD = 0
const LZMA2_METHOD = 0x21

const NID = {
  End: 0x00,
  Header: 0x01,
  ArchiveProperties: 0x02,
  AdditionalStreamsInfo: 0x03,
  MainStreamsInfo: 0x04,
  FilesInfo: 0x05,
  PackInfo: 0x06,
  UnpackInfo: 0x07,
  SubStreamsInfo: 0x08,
  Size: 0x09,
  CRC: 0x0a,
  Folder: 0x0b,
  CodersUnpackSize: 0x0c,
  NumUnpackStream: 0x0d,
  EmptyStream: 0x0e,
  EmptyFile: 0x0f,
  Anti: 0x10,
  Name: 0x11,
  CTime: 0x12,
  ATime: 0x13,
  MTime: 0x14,
  WinAttributes: 0x15,
  EncodedHeader: 0x17
} as const

export type SevenZipMethod = 'copy' | 'lzma2'

export interface SevenZipEntryInput {
  path: string
  size: bigint
  isDirectory?: boolean
  modified?: Date
  mode?: number
  open?: () => ReadableStream<Uint8Array>
}

export interface CreateSevenZipOptions {
  method?: SevenZipMethod
  dictionarySize?: number
  signal?: AbortSignal
  onProgress?: (processedBytes: bigint, currentFile?: string) => void
  /** Optional off-main-thread codec hook used by the Electron adapter. */
  encodeLzma2Chunk?: (chunk: Uint8Array, signal?: AbortSignal) => Promise<{ data: Uint8Array; compressed: boolean }>
  lzmaEncoder?: LzmaEncoderOptions
}

export interface SevenZipEntry {
  id: number
  path: string
  size: bigint
  packedSize?: bigint
  isDirectory: boolean
  encrypted: false
  modified?: Date
  mode?: number
  crc?: number
}

interface WrittenStream {
  packedSize: bigint
  unpackedSize: bigint
  crc: number
  method: SevenZipMethod
  dictionaryProperty?: number
}

interface ParsedFolder {
  methodId: number
  properties: Uint8Array
  unpackSize: bigint
  crc?: number
  packIndex: number
  packedOffset?: bigint
  packedSize?: bigint
  substreams?: ParsedSubstream[]
}

interface ParsedSubstream {
  size: bigint
  crc?: number
}

interface ParsedStreams {
  packPosition: bigint
  packSizes: bigint[]
  folders: ParsedFolder[]
}

interface ParsedFile {
  path: string
  isDirectory: boolean
  size: bigint
  modified?: Date
  mode?: number
  crc?: number
  folder?: ParsedFolder
  substreamIndex?: number
  packedSize?: bigint
}

export interface OpenSevenZipOptions {
  signal?: AbortSignal
  maxEntries?: number
  maxHeaderBytes?: number
  maxDictionaryBytes?: number
  lzma2DecoderFactory?: (
    dictionaryProperty: number,
    signal?: AbortSignal
  ) => Promise<Lzma2DecoderSession | null>
  decodeLzma2Buffer?: (
    input: Uint8Array,
    dictionaryProperty: number,
    expectedSize: number,
    signal?: AbortSignal
  ) => Promise<Uint8Array | null>
}

export interface OpenEntryOptions {
  signal?: AbortSignal
}

export type SevenZipEntryEvent =
  | { type: 'entry-start'; entry: SevenZipEntry }
  | { type: 'data'; entryId: number; bytes: Uint8Array }
  | { type: 'entry-end'; entry: SevenZipEntry }

export interface Lzma2DecoderSession {
  resetDictionary(): Promise<void>
  setProperties(value: number): Promise<void>
  resetState(): Promise<void>
  writeUncompressed(bytes: Uint8Array): Promise<void>
  decodeChunk(bytes: Uint8Array, outputSize: number, signal?: AbortSignal): Promise<Uint8Array>
  close(): Promise<void>
}

function assertArchivePath(value: string): void {
  if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Archive path must be relative: ${value}`)
  }
  const parts = value.replace(/\\/g, '/').split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Archive path contains an unsafe segment: ${value}`)
  }
}

function utf16Le(value: string): Uint8Array {
  const result = new Uint8Array((value.length + 1) * 2)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    result[index * 2] = code & 0xff
    result[index * 2 + 1] = code >>> 8
  }
  return result
}

function dateToFileTime(value: Date): bigint {
  const milliseconds = value.getTime()
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid modification date')
  return BigInt(Math.trunc(milliseconds + 11_644_473_600_000)) * 10_000n
}

function fileTimeToDate(value: bigint): Date | undefined {
  const milliseconds = Number(value / 10_000n) - 11_644_473_600_000
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date : undefined
}

function entryAttributes(entry: SevenZipEntryInput): number {
  const directory = entry.isDirectory === true
  const permission = entry.mode ?? (directory ? 0o755 : 0o644)
  const unixMode = (directory ? 0o040000 : 0o100000) | (permission & 0o7777)
  return (((unixMode & 0xffff) << 16) | (directory ? 0x10 : 0x20)) >>> 0
}

function writeProperty(writer: ByteWriter, id: number, value: Uint8Array): void {
  writer.byte(id).variableUint64(BigInt(value.length)).bytesValue(value)
}

function writeFolder(writer: ByteWriter, stream: WrittenStream): void {
  writer.variableUint64(1n)
  if (stream.method === 'copy') {
    writer.byte(0x01).byte(COPY_METHOD)
  } else {
    writer.byte(0x21).byte(LZMA2_METHOD).variableUint64(1n).byte(stream.dictionaryProperty!)
  }
}

function buildNextHeader(entries: readonly SevenZipEntryInput[], streams: readonly WrittenStream[]): Uint8Array {
  const writer = new ByteWriter().byte(NID.Header)

  if (streams.length > 0) {
    writer.byte(NID.MainStreamsInfo)
    writer.byte(NID.PackInfo)
      .variableUint64(0n)
      .variableUint64(BigInt(streams.length))
      .byte(NID.Size)
    for (const stream of streams) writer.variableUint64(stream.packedSize)
    writer.byte(NID.End)

    writer.byte(NID.UnpackInfo)
      .byte(NID.Folder)
      .variableUint64(BigInt(streams.length))
      .byte(0)
    for (const stream of streams) writeFolder(writer, stream)
    writer.byte(NID.CodersUnpackSize)
    for (const stream of streams) writer.variableUint64(stream.unpackedSize)
    writer.byte(NID.End)

    // libarchive (and therefore macOS Archive Utility) rejects archives whose
    // single-file stream CRCs are stored as folder CRCs in UnpackInfo. Keep the
    // folders without digests and describe the same CRCs as substream digests,
    // matching the layout emitted by 7-Zip itself.
    writer.byte(NID.SubStreamsInfo)
    writer.byte(NID.CRC).byte(1)
    for (const stream of streams) writer.uint32(stream.crc)
    writer.byte(NID.End)
    writer.byte(NID.End)
  }

  writer.byte(NID.FilesInfo).variableUint64(BigInt(entries.length))
  const emptyStreams = entries.map(entry => entry.isDirectory === true || entry.size === 0n)
  if (emptyStreams.some(Boolean)) {
    writeProperty(writer, NID.EmptyStream, bitVector(emptyStreams))
    const emptyFiles = entries.filter((_, index) => emptyStreams[index]).map(entry => entry.isDirectory !== true)
    if (emptyFiles.some(Boolean)) writeProperty(writer, NID.EmptyFile, bitVector(emptyFiles))
  }

  const nameBytes = concatBytes([Uint8Array.of(0), ...entries.map(entry => utf16Le(entry.path.replace(/\\/g, '/')))])
  writeProperty(writer, NID.Name, nameBytes)

  const definedTimes = entries.map(entry => entry.modified !== undefined)
  if (definedTimes.some(Boolean)) {
    const time = new ByteWriter()
    if (definedTimes.every(Boolean)) time.byte(1)
    else time.byte(0).bytesValue(bitVector(definedTimes))
    time.byte(0)
    for (const entry of entries) if (entry.modified) time.uint64(dateToFileTime(entry.modified))
    writeProperty(writer, NID.MTime, time.build())
  }

  const attributes = new ByteWriter().byte(1).byte(0)
  for (const entry of entries) attributes.uint32(entryAttributes(entry))
  writeProperty(writer, NID.WinAttributes, attributes.build())
  writer.byte(NID.End).byte(NID.End)
  return writer.build()
}

function signatureHeader(nextHeaderOffset: bigint, nextHeader: Uint8Array): Uint8Array {
  const startHeader = new ByteWriter()
    .uint64(nextHeaderOffset)
    .uint64(BigInt(nextHeader.length))
    .uint32(crc32(nextHeader))
    .build()
  return new ByteWriter()
    .bytesValue(SIGNATURE)
    .byte(0)
    .byte(4)
    .uint32(crc32(startHeader))
    .bytesValue(startHeader)
    .build()
}

async function consumeEntry(
  entry: SevenZipEntryInput,
  sink: SeekableSink,
  method: SevenZipMethod,
  dictionaryProperty: number,
  options: CreateSevenZipOptions,
  processed: { value: bigint }
): Promise<WrittenStream> {
  if (!entry.open) throw new TypeError(`File entry has no content stream: ${entry.path}`)
  const reader = entry.open().getReader()
  const crc = new Crc32()
  let unpackedSize = 0n
  let packedSize = 0n
  let pending = new Uint8Array(0)

  const writeRaw = async (bytes: Uint8Array) => {
    crc.update(bytes)
    unpackedSize += BigInt(bytes.length)
    processed.value += BigInt(bytes.length)
    options.onProgress?.(processed.value, entry.path)
    if (method === 'copy') {
      await sink.write(bytes, options.signal)
      packedSize += BigInt(bytes.length)
      return
    }

    const joined = pending.length === 0 ? bytes : concatBytes([pending, bytes])
    let offset = 0
    while (joined.length - offset >= LZMA2_ENCODE_CHUNK_SIZE) {
      const chunk = joined.subarray(offset, offset + LZMA2_ENCODE_CHUNK_SIZE)
      const encoded = options.encodeLzma2Chunk
        ? await options.encodeLzma2Chunk(chunk, options.signal)
        : encodeLzma2Block(chunk, options.lzmaEncoder)
      await sink.write(encoded.data, options.signal)
      packedSize += BigInt(encoded.data.length)
      offset += LZMA2_ENCODE_CHUNK_SIZE
    }
    pending = joined.slice(offset)
  }

  try {
    while (true) {
      throwIfCancelled(options.signal)
      const item = await reader.read()
      if (item.done) break
      if (!(item.value instanceof Uint8Array)) throw new TypeError(`Entry stream did not yield Uint8Array: ${entry.path}`)
      await writeRaw(item.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (unpackedSize !== entry.size) {
    throw new Libera7zError(
      'INVALID_ARCHIVE',
      `Entry ${entry.path} yielded ${unpackedSize} bytes but declared ${entry.size}`
    )
  }

  if (method === 'lzma2') {
    if (pending.length > 0) {
      const encoded = options.encodeLzma2Chunk
        ? await options.encodeLzma2Chunk(pending, options.signal)
        : encodeLzma2Block(pending, options.lzmaEncoder)
      await sink.write(encoded.data, options.signal)
      packedSize += BigInt(encoded.data.length)
    }
    await sink.write(Uint8Array.of(0), options.signal)
    packedSize += 1n
  }

  return {
    packedSize,
    unpackedSize,
    crc: crc.digest(),
    method,
    ...(method === 'lzma2' ? { dictionaryProperty } : {})
  }
}

export async function create7z(
  entries: readonly SevenZipEntryInput[],
  sink: SeekableSink,
  options: CreateSevenZipOptions = {}
): Promise<{ size: bigint; headerSize: number }> {
  if (entries.length === 0) throw new Libera7zError('UNSUPPORTED_FEATURE', 'A 7z archive needs at least one entry')
  const seen = new Set<string>()
  for (const entry of entries) {
    assertArchivePath(entry.path)
    if (entry.size < 0n) throw new RangeError(`Entry size is negative: ${entry.path}`)
    if (entry.isDirectory && entry.size !== 0n) throw new RangeError(`Directory size is not zero: ${entry.path}`)
    const key = entry.path.replace(/\\/g, '/')
    if (seen.has(key)) throw new Libera7zError('UNSUPPORTED_FEATURE', `Duplicate archive path: ${key}`)
    seen.add(key)
  }

  const method = options.method ?? 'lzma2'
  const dictionarySize = options.dictionarySize ?? 16 * 1024 * 1024
  const dictionaryProperty = dictionaryPropertyForSize(dictionarySize)
  const streams: WrittenStream[] = []
  const processed = { value: 0n }
  let closed = false

  try {
    await sink.write(new Uint8Array(SIGNATURE_HEADER_SIZE), options.signal)
    for (const entry of entries) {
      throwIfCancelled(options.signal)
      if (entry.isDirectory || entry.size === 0n) continue
      streams.push(await consumeEntry(entry, sink, method, dictionaryProperty, options, processed))
    }
    const nextHeaderOffset = sink.position - BigInt(SIGNATURE_HEADER_SIZE)
    const header = buildNextHeader(entries, streams)
    await sink.write(header, options.signal)
    await sink.writeAt(0n, signatureHeader(nextHeaderOffset, header), options.signal)
    await sink.close()
    closed = true
    return { size: sink.position, headerSize: header.length }
  } finally {
    if (!closed) await sink.close().catch(() => undefined)
  }
}

function readDigests(reader: ByteReader, count: number): Array<number | undefined> {
  const allDefined = reader.byte() !== 0
  const defined = allDefined ? Array<boolean>(count).fill(true) : readBitVector(reader, count)
  return defined.map(isDefined => isDefined ? reader.uint32() : undefined)
}

function readMethodId(reader: ByteReader, length: number): number {
  if (length < 1 || length > 8) throw invalidArchive('Invalid 7z coder method ID length')
  let value = 0
  for (let index = 0; index < length; index += 1) {
    value = (value * 256) + reader.byte()
    if (!Number.isSafeInteger(value)) throw unsupportedFeature('Coder method ID is too large')
  }
  return value
}

function parseFolder(reader: ByteReader, packIndex: number): ParsedFolder {
  const numCoders = reader.safeNumber('7z folder coder count')
  if (numCoders !== 1) throw unsupportedFeature('Only one-coder, non-filtered 7z folders are supported')
  const flags = reader.byte()
  if ((flags & 0x80) !== 0) throw unsupportedFeature('Alternative 7z coder methods are unsupported')
  const methodId = readMethodId(reader, flags & 0x0f)
  const complex = (flags & 0x10) !== 0
  const inputStreams = complex ? reader.safeNumber('7z coder input count') : 1
  const outputStreams = complex ? reader.safeNumber('7z coder output count') : 1
  if (inputStreams !== 1 || outputStreams !== 1) throw unsupportedFeature('Multi-stream 7z coders are unsupported')
  const properties = (flags & 0x20) !== 0
    ? reader.read(reader.safeNumber('7z coder properties size')).slice()
    : new Uint8Array(0)
  if (methodId === COPY_METHOD && properties.length !== 0) throw invalidArchive('Copy coder has unexpected properties')
  if (methodId === LZMA2_METHOD && properties.length !== 1) throw invalidArchive('LZMA2 coder properties are malformed')
  if (methodId !== COPY_METHOD && methodId !== LZMA2_METHOD) {
    throw new Libera7zError('UNSUPPORTED_METHOD', `Unsupported 7z coder: 0x${methodId.toString(16)}`)
  }
  return { methodId, properties, unpackSize: 0n, packIndex }
}

function parsePackInfo(reader: ByteReader): { packPosition: bigint; packSizes: bigint[] } {
  const packPosition = reader.variableUint64()
  const count = reader.safeNumber('7z packed stream count')
  let sizes: bigint[] | undefined
  while (true) {
    const id = reader.byte()
    if (id === NID.End) break
    if (id === NID.Size) {
      sizes = Array.from({ length: count }, () => reader.variableUint64())
    } else if (id === NID.CRC) {
      readDigests(reader, count)
    } else {
      throw unsupportedFeature(`Unsupported PackInfo property: 0x${id.toString(16)}`)
    }
  }
  if (!sizes) throw invalidArchive('7z PackInfo has no packed sizes')
  return { packPosition, packSizes: sizes }
}

function parseUnpackInfo(reader: ByteReader, packStreamCount: number): ParsedFolder[] {
  if (reader.byte() !== NID.Folder) throw invalidArchive('7z UnpackInfo has no Folder section')
  const count = reader.safeNumber('7z folder count')
  if (reader.byte() !== 0) throw unsupportedFeature('External 7z folder definitions are unsupported')
  if (count !== packStreamCount) throw unsupportedFeature('Only one packed stream per 7z folder is supported')
  const folders = Array.from({ length: count }, (_, index) => parseFolder(reader, index))
  if (reader.byte() !== NID.CodersUnpackSize) throw invalidArchive('7z folder sizes are missing')
  for (const folder of folders) folder.unpackSize = reader.variableUint64()
  let id = reader.byte()
  if (id === NID.CRC) {
    const digests = readDigests(reader, count)
    folders.forEach((folder, index) => { folder.crc = digests[index] })
    id = reader.byte()
  }
  if (id !== NID.End) throw unsupportedFeature(`Unsupported UnpackInfo property: 0x${id.toString(16)}`)
  return folders
}

function parseSubstreamsInfo(reader: ByteReader, folders: ParsedFolder[]): void {
  const counts = Array<number>(folders.length).fill(1)
  let id = reader.byte()
  if (id === NID.NumUnpackStream) {
    for (let index = 0; index < folders.length; index += 1) {
      counts[index] = reader.safeNumber('7z folder substream count')
    }
    id = reader.byte()
  }

  const substreams = counts.map(count => Array.from({ length: count }, (): ParsedSubstream => ({ size: 0n })))
  if (id === NID.Size) {
    for (let folderIndex = 0; folderIndex < folders.length; folderIndex += 1) {
      let assigned = 0n
      for (let streamIndex = 0; streamIndex + 1 < counts[folderIndex]; streamIndex += 1) {
        const size = reader.variableUint64()
        assigned += size
        if (assigned > folders[folderIndex].unpackSize) {
          throw invalidArchive('7z substream sizes exceed their folder size')
        }
        substreams[folderIndex][streamIndex].size = size
      }
    }
    id = reader.byte()
  } else if (counts.some(count => count > 1)) {
    throw invalidArchive('Solid 7z folder has no substream sizes')
  }

  for (let folderIndex = 0; folderIndex < folders.length; folderIndex += 1) {
    const streams = substreams[folderIndex]
    if (streams.length === 0) continue
    const assigned = streams.slice(0, -1).reduce((total, stream) => total + stream.size, 0n)
    if (assigned > folders[folderIndex].unpackSize) {
      throw invalidArchive('7z substream sizes exceed their folder size')
    }
    streams[streams.length - 1].size = folders[folderIndex].unpackSize - assigned
  }

  const digestTargets: ParsedSubstream[] = []
  for (let folderIndex = 0; folderIndex < folders.length; folderIndex += 1) {
    const streams = substreams[folderIndex]
    if (streams.length === 1 && folders[folderIndex].crc !== undefined) {
      streams[0].crc = folders[folderIndex].crc
    } else {
      digestTargets.push(...streams)
    }
  }
  if (id === NID.CRC) {
    const digests = readDigests(reader, digestTargets.length)
    digestTargets.forEach((stream, index) => { stream.crc = digests[index] })
    id = reader.byte()
  }
  if (id !== NID.End) throw unsupportedFeature(`Unsupported SubStreamsInfo property: 0x${id.toString(16)}`)
  folders.forEach((folder, index) => { folder.substreams = substreams[index] })
}

function parseStreamsInfo(reader: ByteReader): ParsedStreams {
  let packPosition = 0n
  let packSizes: bigint[] = []
  let folders: ParsedFolder[] = []
  while (true) {
    const id = reader.byte()
    if (id === NID.End) break
    if (id === NID.PackInfo) {
      const pack = parsePackInfo(reader)
      packPosition = pack.packPosition
      packSizes = pack.packSizes
    } else if (id === NID.UnpackInfo) {
      folders = parseUnpackInfo(reader, packSizes.length)
    } else if (id === NID.SubStreamsInfo) {
      parseSubstreamsInfo(reader, folders)
    } else {
      throw unsupportedFeature(`Unsupported StreamsInfo section: 0x${id.toString(16)}`)
    }
  }
  if (packSizes.length !== folders.length) throw invalidArchive('7z stream and folder counts do not match')
  let packedOffset = 32n + packPosition
  folders.forEach((folder, index) => {
    folder.packedOffset = packedOffset
    folder.packedSize = packSizes[index]
    folder.substreams ??= [{ size: folder.unpackSize, crc: folder.crc }]
    packedOffset += packSizes[index]
  })
  return { packPosition, packSizes, folders }
}

function parseDefinedVector(reader: ByteReader, count: number): boolean[] {
  return reader.byte() !== 0 ? Array<boolean>(count).fill(true) : readBitVector(reader, count)
}

function parseNames(data: Uint8Array, count: number): string[] {
  const reader = new ByteReader(data)
  if (reader.byte() !== 0) throw unsupportedFeature('External 7z file names are unsupported')
  if ((reader.remaining & 1) !== 0) throw invalidArchive('7z file-name table has an incomplete UTF-16 code unit')
  const names: string[] = []
  const decoder = new TextDecoder('utf-16le')
  let nameStart = reader.position
  while (reader.remaining > 0) {
    const unit = reader.byte() | (reader.byte() << 8)
    if (unit === 0) {
      names.push(decoder.decode(data.subarray(nameStart, reader.position - 2)))
      nameStart = reader.position
    }
  }
  if (nameStart !== reader.position || names.length !== count) throw invalidArchive('7z file-name table is malformed')
  return names
}

function parseTimes(data: Uint8Array, count: number): Array<Date | undefined> {
  const reader = new ByteReader(data)
  const defined = parseDefinedVector(reader, count)
  if (reader.byte() !== 0) throw unsupportedFeature('External 7z timestamps are unsupported')
  const values = defined.map(isDefined => isDefined ? fileTimeToDate(reader.uint64()) : undefined)
  reader.assertFinished('7z timestamp property')
  return values
}

function parseAttributes(data: Uint8Array, count: number): Array<number | undefined> {
  const reader = new ByteReader(data)
  const defined = parseDefinedVector(reader, count)
  if (reader.byte() !== 0) throw unsupportedFeature('External 7z attributes are unsupported')
  const values = defined.map(isDefined => isDefined ? reader.uint32() : undefined)
  reader.assertFinished('7z attributes property')
  return values
}

function parseFilesInfo(reader: ByteReader, streams: ParsedStreams): ParsedFile[] {
  const count = reader.safeNumber('7z file count')
  let names: string[] | undefined
  let emptyStreams = Array<boolean>(count).fill(false)
  let emptyFiles: boolean[] = []
  let antiFiles: boolean[] = []
  let modified: Array<Date | undefined> = Array(count).fill(undefined)
  let attributes: Array<number | undefined> = Array(count).fill(undefined)

  while (true) {
    const id = reader.byte()
    if (id === NID.End) break
    const propertySize = reader.safeNumber('7z file property size')
    const property = reader.read(propertySize)
    if (id === NID.Name) names = parseNames(property, count)
    else if (id === NID.EmptyStream) emptyStreams = readBitVector(new ByteReader(property), count)
    else if (id === NID.EmptyFile) emptyFiles = readBitVector(new ByteReader(property), emptyStreams.filter(Boolean).length)
    else if (id === NID.Anti) antiFiles = readBitVector(new ByteReader(property), emptyStreams.filter(Boolean).length)
    else if (id === NID.MTime) modified = parseTimes(property, count)
    else if (id === NID.WinAttributes) attributes = parseAttributes(property, count)
    // Unknown file metadata is size-delimited and can be ignored safely.
  }
  if (!names) throw invalidArchive('7z archive has no file-name table')

  let emptyIndex = 0
  const streamReferences = streams.folders.flatMap(folder =>
    folder.substreams!.map((substream, substreamIndex) => ({ folder, substream, substreamIndex })))
  let streamIndex = 0
  const files = names.map((path, index) => {
    let isDirectory = false
    let size = 0n
    let crc: number | undefined
    let folder: ParsedFolder | undefined
    let substreamIndex: number | undefined
    let packedSize: bigint | undefined
    if (emptyStreams[index]) {
      const isEmptyFile = emptyFiles[emptyIndex] === true
      const isAnti = antiFiles[emptyIndex] === true
      emptyIndex += 1
      if (isAnti) throw unsupportedFeature('7z anti-file entries are unsupported')
      isDirectory = !isEmptyFile
    } else {
      const reference = streamReferences[streamIndex++]
      if (!reference) throw invalidArchive('7z file table references a missing substream')
      folder = reference.folder
      substreamIndex = reference.substreamIndex
      size = reference.substream.size
      crc = reference.substream.crc
      if (substreamIndex === 0) packedSize = folder.packedSize
    }
    const rawAttributes = attributes[index]
    const unixMode = rawAttributes === undefined ? undefined : (rawAttributes >>> 16) & 0xffff
    const unixType = unixMode === undefined ? 0 : unixMode & 0o170000
    if (unixType === 0o120000) throw unsupportedFeature('Symbolic-link entries require the compatibility backend')
    if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000) {
      throw unsupportedFeature('Special-file entries require the compatibility backend')
    }
    return {
      path,
      isDirectory,
      size,
      modified: modified[index],
      mode: unixMode === undefined ? undefined : unixMode & 0o7777,
      crc,
      folder,
      substreamIndex,
      packedSize
    }
  })
  if (streamIndex !== streamReferences.length) {
    throw invalidArchive('7z stream table contains more substreams than files')
  }
  return files
}

function parseHeader(bytes: Uint8Array): ParsedFile[] {
  const reader = new ByteReader(bytes)
  if (reader.byte() !== NID.Header) throw invalidArchive('7z NextHeader does not begin with Header')
  let streams: ParsedStreams = { packPosition: 0n, packSizes: [], folders: [] }
  let files: ParsedFile[] | undefined
  while (true) {
    const id = reader.byte()
    if (id === NID.End) break
    if (id === NID.MainStreamsInfo) streams = parseStreamsInfo(reader)
    else if (id === NID.FilesInfo) files = parseFilesInfo(reader, streams)
    else if (id === NID.ArchiveProperties || id === NID.AdditionalStreamsInfo) {
      throw unsupportedFeature('7z archive/additional properties are unsupported')
    } else {
      throw unsupportedFeature(`Unsupported 7z header section: 0x${id.toString(16)}`)
    }
  }
  reader.assertFinished('7z NextHeader')
  if (!files) throw invalidArchive('7z archive has no FilesInfo section')
  return files
}

async function decodeEncodedHeader(
  source: RandomAccessSource,
  bytes: Uint8Array,
  signal?: AbortSignal,
  decodeBuffer?: OpenSevenZipOptions['decodeLzma2Buffer']
): Promise<Uint8Array> {
  const reader = new ByteReader(bytes)
  if (reader.byte() !== NID.EncodedHeader) throw invalidArchive('Invalid encoded-header marker')
  const streams = parseStreamsInfo(reader)
  reader.assertFinished('encoded 7z header descriptor')
  if (
    streams.folders.length !== 1 ||
    streams.packSizes.length !== 1 ||
    streams.folders[0].substreams?.length !== 1
  ) {
    throw unsupportedFeature('Only one-stream encoded 7z headers are supported')
  }
  const folder = streams.folders[0]
  const packedSize = uint64ToSafeNumber(streams.packSizes[0], 'Encoded 7z header size')
  if (packedSize > MAX_ENCODED_HEADER_SIZE || folder.unpackSize > BigInt(MAX_ENCODED_HEADER_SIZE)) {
    throw new Libera7zError('LIMIT_EXCEEDED', 'Encoded 7z header exceeds the 64 MiB limit')
  }
  const packed = await readExactly(source, 32n + streams.packPosition, packedSize, signal)
  let decoded: Uint8Array
  if (folder.methodId === COPY_METHOD) decoded = packed
  else if (folder.methodId === LZMA2_METHOD && folder.properties.length === 1) {
    decoded = await decodeBuffer?.(packed, folder.properties[0], Number(folder.unpackSize), signal) ??
      decodeLzma2(packed, folder.properties[0], Number(folder.unpackSize), signal)
  } else {
    throw new Libera7zError('UNSUPPORTED_METHOD', `Unsupported encoded-header coder: 0x${folder.methodId.toString(16)}`)
  }
  if (folder.crc !== undefined && crc32(decoded) !== folder.crc) {
    throw new Libera7zError('CRC_MISMATCH', 'Encoded 7z header CRC does not match')
  }
  return decoded
}

class PackedCursor {
  private position = 0n

  constructor(
    private readonly source: RandomAccessSource,
    private readonly start: bigint,
    private readonly length: bigint,
    private readonly signal?: AbortSignal
  ) {}

  get remaining(): bigint {
    return this.length - this.position
  }

  async read(length: number): Promise<Uint8Array> {
    if (BigInt(length) > this.remaining) throw invalidArchive('Compressed stream is truncated')
    const value = await readExactly(this.source, this.start + this.position, length, this.signal)
    this.position += BigInt(length)
    return value
  }

  async byte(): Promise<number> {
    return (await this.read(1))[0]
  }
}

async function* decodeLzma2FromSource(
  cursor: PackedCursor,
  property: number,
  expectedSize: bigint,
  signal?: AbortSignal,
  decoderFactory?: OpenSevenZipOptions['lzma2DecoderFactory']
): AsyncGenerator<Uint8Array> {
  let decoder = await decoderFactory?.(property, signal)
  if (!decoder) {
    const localDecoder = new LzmaDecoder(dictionarySizeFromProperty(property))
    decoder = {
      resetDictionary: async () => localDecoder.resetDictionary(),
      setProperties: async (value: number) => localDecoder.setProperties(value),
      resetState: async () => localDecoder.resetState(),
      writeUncompressed: async (bytes: Uint8Array) => localDecoder.writeUncompressed(bytes),
      decodeChunk: async (bytes: Uint8Array, size: number, operationSignal?: AbortSignal) =>
        localDecoder.decodeChunk(bytes, size, operationSignal),
      close: async () => undefined
    }
  }
  let total = 0n
  let needsDictionaryReset = true
  let needsProperties = true
  let needsStateReset = true

  try {
    while (true) {
      throwIfCancelled(signal)
      const control = await cursor.byte()
      if (control === 0) break
      if (control === 1 || control === 2) {
        if (control === 1) {
          await decoder.resetDictionary()
          needsDictionaryReset = false
        } else if (needsDictionaryReset) throw invalidArchive('LZMA2 dictionary was not reset')
        const length = (((await cursor.byte()) << 8) | await cursor.byte()) + 1
        const bytes = await cursor.read(length)
        await decoder.writeUncompressed(bytes)
        total += BigInt(bytes.length)
        yield bytes
        needsStateReset = true
        continue
      }
      if (control < 0x80) throw invalidArchive('Invalid LZMA2 control byte')
      if (control >= 0xe0) {
        await decoder.resetDictionary()
        needsDictionaryReset = false
      } else if (needsDictionaryReset) throw invalidArchive('LZMA2 dictionary was not reset')
      const unpacked = (((control & 0x1f) << 16) | ((await cursor.byte()) << 8) | await cursor.byte()) + 1
      const packed = (((await cursor.byte()) << 8) | await cursor.byte()) + 1
      if (control >= 0xc0) {
        await decoder.setProperties(await cursor.byte())
        needsProperties = false
      } else if (needsProperties) throw invalidArchive('LZMA2 properties were not supplied')
      if (control >= 0xa0) {
        await decoder.resetState()
        needsStateReset = false
      } else if (needsStateReset) throw invalidArchive('LZMA2 state was not reset')
      const decoded = await decoder.decodeChunk(await cursor.read(packed), unpacked, signal)
      total += BigInt(decoded.length)
      yield decoded
    }
  } finally {
    await decoder.close()
  }
  if (cursor.remaining !== 0n) throw invalidArchive('LZMA2 packed stream contains trailing bytes')
  if (total !== expectedSize) throw invalidArchive('LZMA2 output size does not match the 7z header')
}

async function* decodeFolderFromSource(
  source: RandomAccessSource,
  folder: ParsedFolder,
  signal?: AbortSignal,
  decoderFactory?: OpenSevenZipOptions['lzma2DecoderFactory']
): AsyncGenerator<Uint8Array> {
  if (folder.packedOffset === undefined || folder.packedSize === undefined) {
    throw invalidArchive('7z folder has no packed stream')
  }
  const cursor = new PackedCursor(source, folder.packedOffset, folder.packedSize, signal)
  if (folder.methodId === COPY_METHOD) {
    let remaining = folder.unpackSize
    while (remaining > 0n) {
      throwIfCancelled(signal)
      const length = Number(remaining > 1024n * 1024n ? 1024n * 1024n : remaining)
      const bytes = await cursor.read(length)
      remaining -= BigInt(bytes.length)
      yield bytes
    }
    if (cursor.remaining !== 0n) throw invalidArchive('Copy stream size does not match the 7z folder size')
    return
  }
  if (folder.methodId === LZMA2_METHOD && folder.properties.length === 1) {
    yield* decodeLzma2FromSource(
      cursor,
      folder.properties[0],
      folder.unpackSize,
      signal,
      decoderFactory
    )
    return
  }
  throw new Libera7zError('UNSUPPORTED_METHOD', `Unsupported 7z coder: 0x${folder.methodId.toString(16)}`)
}

class FolderOutputReader {
  private buffer: Uint8Array | null = null
  private bufferOffset = 0
  private ended = false
  private readonly crc = new Crc32()

  constructor(
    private readonly iterator: AsyncGenerator<Uint8Array>,
    private readonly folder: ParsedFolder
  ) {}

  async read(maxLength: number): Promise<Uint8Array | null> {
    if (maxLength < 1) throw new RangeError('Folder output read length must be positive')
    while (!this.buffer || this.bufferOffset === this.buffer.length) {
      const item = await this.iterator.next()
      if (item.done) {
        this.ended = true
        return null
      }
      if (item.value.length === 0) continue
      this.buffer = item.value
      this.bufferOffset = 0
    }
    const end = Math.min(this.buffer.length, this.bufferOffset + maxLength)
    const bytes = this.buffer.subarray(this.bufferOffset, end)
    this.bufferOffset = end
    this.crc.update(bytes)
    return bytes
  }

  async finish(): Promise<void> {
    if (this.buffer && this.bufferOffset !== this.buffer.length) {
      throw invalidArchive('7z folder expands beyond its declared substream sizes')
    }
    if (!this.ended) {
      const item = await this.iterator.next()
      if (!item.done) throw invalidArchive('7z folder expands beyond its declared substream sizes')
      this.ended = true
    }
    if (this.folder.crc !== undefined && this.crc.digest() !== this.folder.crc) {
      throw new Libera7zError('CRC_MISMATCH', '7z folder CRC does not match')
    }
  }

  async close(): Promise<void> {
    if (!this.ended) await this.iterator.return(undefined).catch(() => undefined)
    this.ended = true
  }
}

async function* readFolderSubstream(
  reader: FolderOutputReader,
  substream: ParsedSubstream,
  description: string,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  let remaining = substream.size
  const crc = new Crc32()
  while (remaining > 0n) {
    throwIfCancelled(signal)
    const limit = Number(remaining > 1024n * 1024n ? 1024n * 1024n : remaining)
    const bytes = await reader.read(limit)
    if (!bytes) throw invalidArchive(`7z folder ended before ${description}`)
    remaining -= BigInt(bytes.length)
    crc.update(bytes)
    yield bytes
  }
  throwIfCancelled(signal)
  if (substream.crc !== undefined && crc.digest() !== substream.crc) {
    throw new Libera7zError('CRC_MISMATCH', `CRC mismatch for ${description}`)
  }
}

export class SevenZipArchive {
  readonly entries: readonly SevenZipEntry[]

  constructor(
    private readonly source: RandomAccessSource,
    private readonly parsedFiles: readonly ParsedFile[],
    private readonly decoderFactory?: OpenSevenZipOptions['lzma2DecoderFactory']
  ) {
    this.entries = parsedFiles.map((file, id) => ({
      id,
      path: file.path,
      size: file.size,
      packedSize: file.packedSize,
      isDirectory: file.isDirectory,
      encrypted: false,
      modified: file.modified,
      mode: file.mode,
      crc: file.crc
    }))
  }

  openEntries(ids: readonly number[], options: OpenEntryOptions = {}): ReadableStream<SevenZipEntryEvent> {
    const files = [...new Set(ids)].map(id => {
      const file = this.parsedFiles[id]
      if (!file) throw new Libera7zError('INVALID_ARCHIVE', `7z entry ${id} does not exist`)
      if (file.isDirectory) throw new Libera7zError('UNSUPPORTED_FEATURE', 'Directories have no content stream')
      return { id, file, entry: this.entries[id] }
    }).sort((left, right) => left.id - right.id)

    const source = this.source
    const decoderFactory = this.decoderFactory
    const generator = (async function* (): AsyncGenerator<SevenZipEntryEvent> {
      let activeFolder: ParsedFolder | null = null
      let output: FolderOutputReader | null = null
      let nextSubstream = 0
      try {
        for (const { id, file, entry } of files) {
          throwIfCancelled(options.signal)
          if (!file.folder || file.substreamIndex === undefined) {
            yield { type: 'entry-start', entry }
            yield { type: 'entry-end', entry }
            continue
          }

          if (file.folder !== activeFolder) {
            await output?.close()
            activeFolder = file.folder
            output = new FolderOutputReader(
              decodeFolderFromSource(source, file.folder, options.signal, decoderFactory),
              file.folder
            )
            nextSubstream = 0
          }
          if (file.substreamIndex < nextSubstream) {
            throw invalidArchive('7z files do not follow their solid substream order')
          }
          const folderOutput = output
          if (!folderOutput) throw invalidArchive('7z solid folder decoder was not initialized')
          while (nextSubstream < file.substreamIndex) {
            const skipped = activeFolder.substreams![nextSubstream]
            for await (const bytes of readFolderSubstream(
              folderOutput,
              skipped,
              `solid substream ${nextSubstream}`,
              options.signal
            )) {
              // Decoding skipped streams preserves the LZMA dictionary for the selected entry.
              void bytes
            }
            nextSubstream += 1
          }

          const substream = activeFolder.substreams![nextSubstream]
          if (!substream) throw invalidArchive('7z file references a missing solid substream')
          yield { type: 'entry-start', entry }
          for await (const bytes of readFolderSubstream(folderOutput, substream, file.path, options.signal)) {
            yield { type: 'data', entryId: id, bytes }
          }
          nextSubstream += 1
          if (nextSubstream === activeFolder.substreams!.length) await folderOutput.finish()
          yield { type: 'entry-end', entry }
        }
      } finally {
        await output?.close()
      }
    })()
    return readableFromGenerator(generator)
  }

  openEntry(id: number, options: OpenEntryOptions = {}): ReadableStream<Uint8Array> {
    const events = this.openEntries([id], options)
    const generator = (async function* (): AsyncGenerator<Uint8Array> {
      const reader = events.getReader()
      try {
        while (true) {
          const item = await reader.read()
          if (item.done) return
          if (item.value.type === 'data') yield item.value.bytes
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    })()
    return readableFromGenerator(generator)
  }

  async close(): Promise<void> {
    await this.source.close?.()
  }
}

export async function open7z(
  source: RandomAccessSource,
  options: OpenSevenZipOptions = {}
): Promise<SevenZipArchive> {
  throwIfCancelled(options.signal)
  if (source.size < BigInt(SIGNATURE_HEADER_SIZE)) throw invalidArchive('File is too small to be a 7z archive')
  const signature = await readExactly(source, 0n, SIGNATURE_HEADER_SIZE, options.signal)
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (signature[index] !== SIGNATURE[index]) throw invalidArchive('7z signature does not match')
  }
  if (signature[6] !== 0) throw unsupportedFeature(`Unsupported 7z major version: ${signature[6]}`)
  const startCrc = new ByteReader(signature.subarray(8, 12)).uint32()
  const startHeader = signature.subarray(12, 32)
  if (crc32(startHeader) !== startCrc) throw new Libera7zError('CRC_MISMATCH', '7z StartHeader CRC does not match')
  const startReader = new ByteReader(startHeader)
  const nextOffset = startReader.uint64()
  const nextSize = startReader.uint64()
  const nextCrc = startReader.uint32()
  const headerLimit = options.maxHeaderBytes ?? MAX_ENCODED_HEADER_SIZE
  const headerSize = uint64ToSafeNumber(nextSize, '7z NextHeader size')
  if (headerSize > headerLimit) throw new Libera7zError('LIMIT_EXCEEDED', '7z NextHeader exceeds the configured limit')
  const nextPosition = 32n + nextOffset
  if (nextPosition + nextSize > source.size) throw invalidArchive('7z NextHeader lies beyond the archive')
  const nextHeader = await readExactly(source, nextPosition, headerSize, options.signal)
  if (crc32(nextHeader) !== nextCrc) throw new Libera7zError('CRC_MISMATCH', '7z NextHeader CRC does not match')
  if (nextHeader.length === 0) throw invalidArchive('7z NextHeader is empty')
  const decoded = nextHeader[0] === NID.EncodedHeader
    ? await decodeEncodedHeader(source, nextHeader, options.signal, options.decodeLzma2Buffer)
    : nextHeader
  const files = parseHeader(decoded)
  if (options.maxEntries !== undefined && files.length > options.maxEntries) {
    throw new Libera7zError('LIMIT_EXCEEDED', '7z archive contains too many entries')
  }
  const dictionaryLimit = options.maxDictionaryBytes ?? 256 * 1024 * 1024
  for (const file of files) {
    if (file.folder?.methodId !== LZMA2_METHOD) continue
    const dictionarySize = dictionarySizeFromProperty(file.folder.properties[0])
    if (dictionarySize > dictionaryLimit) {
      throw new Libera7zError('LIMIT_EXCEEDED', `7z dictionary exceeds the ${dictionaryLimit}-byte limit`)
    }
  }
  return new SevenZipArchive(source, files, options.lzma2DecoderFactory)
}
