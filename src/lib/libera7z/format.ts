import { ByteReader, ByteWriter, bitVector, concatBytes, readBitVector, uint64ToSafeNumber } from './binary'
import { Crc32, crc32 } from './crc32'
import { Libera7zError, invalidArchive, throwIfCancelled, unsupportedFeature } from './errors'
import { type RandomAccessSource, type SeekableSink, readExactly, readableFromGenerator } from './io'
import { LzmaDecoder, type LzmaEncoderOptions } from './lzma'
import { decodeLzma1, parseLzma1Properties } from './lzma1'
import { decodePpmd7, parsePpmd7Properties } from './ppmd7'
import {
  decryptAesCbcRaw,
  decryptSevenZipAes,
  defaultRandomBytes,
  deriveSevenZipAesKey,
  generateSevenZipAesProperties,
  importSevenZipAesKey,
  parseSevenZipAesProperties,
  serializeSevenZipAesProperties,
  SevenZipAesEncryptor,
  type SevenZipAesKeyDeriver,
  type SevenZipAesProperties
} from './aes'
import { decodeBzip2 } from './bzip2'
import { decodeBcj2 } from './bcj2'
import { inflateRaw } from './deflate'
import { decodeSevenZipFilter, type SevenZipFilter } from './filters'
import {
  initialLzma2ChunkState,
  planLzma2Chunk,
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
const DELTA_METHOD = 0x03
const ARM64_METHOD = 0x0a
const RISCV_METHOD = 0x0b
const LZMA2_METHOD = 0x21
const SWAP2_METHOD = 0x20302
const SWAP4_METHOD = 0x20304
const LZMA_METHOD = 0x30101
const PPMD_METHOD = 0x30401
const BCJ_METHOD = 0x3030103
const BCJ2_METHOD = 0x303011b
const PPC_METHOD = 0x3030205
const IA64_METHOD = 0x3030401
const ARM_METHOD = 0x3030501
const ARMT_METHOD = 0x3030701
const SPARC_METHOD = 0x3030805
const DEFLATE_METHOD = 0x40108
const DEFLATE64_METHOD = 0x40109
const BZIP2_METHOD = 0x40202
const AES_METHOD = 0x6f10701

const SIMPLE_FILTERS = new Map<number, SevenZipFilter>([
  [DELTA_METHOD, 'delta'],
  [ARM64_METHOD, 'arm64'],
  [RISCV_METHOD, 'riscv'],
  [SWAP2_METHOD, 'swap2'],
  [SWAP4_METHOD, 'swap4'],
  [BCJ_METHOD, 'bcj'],
  [PPC_METHOD, 'ppc'],
  [IA64_METHOD, 'ia64'],
  [ARM_METHOD, 'arm'],
  [ARMT_METHOD, 'armt'],
  [SPARC_METHOD, 'sparc']
])

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
  isSymlink?: boolean
  open?: () => ReadableStream<Uint8Array>
}

export interface CreateSevenZipOptions {
  method?: SevenZipMethod
  dictionarySize?: number
  /** Packs all non-empty files into one folder with per-file substreams. */
  solid?: boolean
  signal?: AbortSignal
  onProgress?: (processedBytes: bigint, currentFile?: string) => void
  /** Optional off-main-thread codec hook used by the Electron adapter. */
  encodeLzma2Chunk?: (chunk: Uint8Array, signal?: AbortSignal) => Promise<{ data: Uint8Array; compressed: boolean }>
  lzmaEncoder?: LzmaEncoderOptions
  /** Encrypts every entry with AES-256. An empty string counts as no password. */
  password?: string
  /** Also encrypts the header, which hides the file names. Needs a password. */
  encryptHeader?: boolean
  /** Overrides salt and IV generation so tests can assert exact bytes. */
  randomBytes?: (length: number) => Uint8Array
}

export interface SevenZipEntry {
  id: number
  path: string
  size: bigint
  packedSize?: bigint
  isDirectory: boolean
  encrypted: boolean
  isSymlink: boolean
  modified?: Date
  mode?: number
  crc?: number
  /** Human-readable primary compression coder, excluding encryption coders. */
  codec?: string
  /** Dictionary/memory size used by LZMA, LZMA2 or PPMd, when applicable. */
  dictionarySize?: number
  /** True when this file shares a packed folder with other file substreams. */
  solid?: boolean
}

export interface SevenZipArchiveMetadata {
  version: string
  nextHeaderOffset: bigint
  nextHeaderSize: bigint
}

interface WrittenStream {
  /** The packed stream size, which is the padded ciphertext when encrypted. */
  packedSize: bigint
  unpackedSize: bigint
  crc: number
  method: SevenZipMethod
  dictionaryProperty?: number
  substreams?: Array<{ size: bigint; crc: number }>
  /** Present when the folder ends in an AES coder. `codedSize` is that coder's
   * declared output, so the trailing zero padding is trimmed on the way back. */
  aes?: { properties: Uint8Array; codedSize: bigint }
}

interface ParsedCoder {
  methodId: number
  properties: Uint8Array
  inputStreams: number
  outputStreams: number
  inputStart: number
  outputStart: number
}

interface ParsedBindPair {
  inputIndex: number
  outputIndex: number
}

interface ParsedFolder {
  coders: ParsedCoder[]
  bindPairs: ParsedBindPair[]
  packedIndices: number[]
  unpackSizes: bigint[]
  finalOutputIndex: number
  unpackSize: bigint
  crc?: number
  packIndex: number
  packedOffsets?: bigint[]
  packedSizes?: bigint[]
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
  isSymlink: boolean
  encrypted: boolean
  crc?: number
  folder?: ParsedFolder
  substreamIndex?: number
  packedSize?: bigint
}

function coderName(methodId: number): string {
  if (methodId === COPY_METHOD) return 'Copy'
  if (methodId === LZMA2_METHOD) return 'LZMA2'
  if (methodId === LZMA_METHOD) return 'LZMA'
  if (methodId === PPMD_METHOD) return 'PPMd'
  if (methodId === DEFLATE_METHOD) return 'Deflate'
  if (methodId === DEFLATE64_METHOD) return 'Deflate64'
  if (methodId === BZIP2_METHOD) return 'BZip2'
  if (methodId === BCJ2_METHOD) return 'BCJ2'
  return SIMPLE_FILTERS.get(methodId)?.toUpperCase() ?? `0x${methodId.toString(16).toUpperCase()}`
}

function folderDictionarySize(folder?: ParsedFolder): number | undefined {
  for (const coder of folder?.coders ?? []) {
    if (coder.methodId === LZMA2_METHOD) return dictionarySizeFromProperty(coder.properties[0])
    if (coder.methodId === LZMA_METHOD) return parseLzma1Properties(coder.properties).dictionarySize
    if (coder.methodId === PPMD_METHOD) return parsePpmd7Properties(coder.properties).memorySize
  }
  return undefined
}

function folderCodec(folder?: ParsedFolder): string | undefined {
  const coders = folder?.coders
    .filter(coder => coder.methodId !== AES_METHOD)
    .map(coder => coderName(coder.methodId))
  return coders?.length ? [...new Set(coders)].join(' + ') : undefined
}

export interface OpenSevenZipOptions {
  signal?: AbortSignal
  maxEntries?: number
  maxHeaderBytes?: number
  maxDictionaryBytes?: number
  password?: string
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
  const symlink = entry.isSymlink === true
  const permission = entry.mode ?? (directory ? 0o755 : symlink ? 0o777 : 0o644)
  const unixMode = (directory ? 0o040000 : symlink ? 0o120000 : 0o100000) | (permission & 0o7777)
  return (((unixMode & 0xffff) << 16) | (directory ? 0x10 : 0x20)) >>> 0
}

function writeProperty(writer: ByteWriter, id: number, value: Uint8Array): void {
  writer.byte(id).variableUint64(BigInt(value.length)).bytesValue(value)
}

/** Coder flags are `idSize | 0x20` when properties follow; the AES method ID is
 * four bytes wide while Copy and LZMA2 are one. */
function writeAesCoder(writer: ByteWriter, properties: Uint8Array): void {
  writer.byte(0x24).byte(0x06).byte(0xf1).byte(0x07).byte(0x01)
    .variableUint64(BigInt(properties.length)).bytesValue(properties)
}

function writeLzma2Coder(writer: ByteWriter, dictionaryProperty: number): void {
  writer.byte(0x21).byte(LZMA2_METHOD).variableUint64(1n).byte(dictionaryProperty)
}

/**
 * Coders are listed in decode order, so an encrypted LZMA2 folder reads
 * `[AES, LZMA2]` with a bind pair joining LZMA2's input to the AES output.
 * Copy folders collapse to a single AES coder, which is what 7-Zip itself
 * emits for `-mx0 -p`. Either way exactly one coder input stays unbound, so
 * the packed index list is inferred rather than written.
 */
function writeFolder(writer: ByteWriter, stream: WrittenStream): void {
  if (!stream.aes) {
    writer.variableUint64(1n)
    if (stream.method === 'copy') writer.byte(0x01).byte(COPY_METHOD)
    else writeLzma2Coder(writer, stream.dictionaryProperty!)
    return
  }
  if (stream.method === 'copy') {
    writer.variableUint64(1n)
    writeAesCoder(writer, stream.aes.properties)
    return
  }
  writer.variableUint64(2n)
  writeAesCoder(writer, stream.aes.properties)
  writeLzma2Coder(writer, stream.dictionaryProperty!)
  writer.variableUint64(1n).variableUint64(0n)
}

/** One size per coder output, in global output-index order. */
function writeCodersUnpackSizes(writer: ByteWriter, stream: WrittenStream): void {
  if (stream.aes && stream.method !== 'copy') writer.variableUint64(stream.aes.codedSize)
  writer.variableUint64(stream.unpackedSize)
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
    for (const stream of streams) writeCodersUnpackSizes(writer, stream)
    writer.byte(NID.End)

    // libarchive (and therefore macOS Archive Utility) rejects archives whose
    // single-file stream CRCs are stored as folder CRCs in UnpackInfo. Keep the
    // folders without digests and describe the same CRCs as substream digests,
    // matching the layout emitted by 7-Zip itself.
    writer.byte(NID.SubStreamsInfo)
    if (streams.some(stream => (stream.substreams?.length ?? 1) > 1)) {
      writer.byte(NID.NumUnpackStream)
      for (const stream of streams) writer.variableUint64(BigInt(stream.substreams?.length ?? 1))
      writer.byte(NID.Size)
      for (const stream of streams) {
        const substreams = stream.substreams
        if (!substreams) continue
        for (let index = 0; index + 1 < substreams.length; index += 1) {
          writer.variableUint64(substreams[index].size)
        }
      }
    }
    writer.byte(NID.CRC).byte(1)
    for (const stream of streams) {
      const substreams = stream.substreams
      if (substreams) {
        for (const substream of substreams) writer.uint32(substream.crc)
      } else {
        writer.uint32(stream.crc)
      }
    }
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

/** Archive-wide encryption state. The key and salt are derived once; only the
 * IV changes per folder, matching 7-Zip. */
interface ArchiveEncryption {
  key: Uint8Array
  cyclesPower: number
  salt: Uint8Array
  randomBytes: (length: number) => Uint8Array
}

async function beginEncryption(
  encryption: ArchiveEncryption
): Promise<{ encryptor: SevenZipAesEncryptor; properties: Uint8Array }> {
  const properties: SevenZipAesProperties = {
    cyclesPower: encryption.cyclesPower,
    salt: encryption.salt,
    iv: encryption.randomBytes(16)
  }
  return {
    encryptor: await SevenZipAesEncryptor.create(encryption.key, properties.iv),
    properties: serializeSevenZipAesProperties(properties)
  }
}

async function consumeEntry(
  entry: SevenZipEntryInput,
  sink: SeekableSink,
  method: SevenZipMethod,
  dictionaryProperty: number,
  options: CreateSevenZipOptions,
  processed: { value: bigint },
  encryption?: ArchiveEncryption
): Promise<WrittenStream> {
  if (!entry.open) throw new TypeError(`File entry has no content stream: ${entry.path}`)
  const aes = encryption ? await beginEncryption(encryption) : undefined
  const reader = entry.open().getReader()
  const crc = new Crc32()
  let unpackedSize = 0n
  let packedSize = 0n
  let pending = new Uint8Array(0)

  // Everything bound for the packed stream goes through here so encryption sits
  // above the sink and below the codec, exactly where the coder chain puts it.
  const emit = async (bytes: Uint8Array) => {
    if (!aes) {
      await sink.write(bytes, options.signal)
      packedSize += BigInt(bytes.length)
      return
    }
    const ciphertext = await aes.encryptor.update(bytes)
    if (ciphertext.length > 0) await sink.write(ciphertext, options.signal)
  }

  const writeRaw = async (bytes: Uint8Array) => {
    crc.update(bytes)
    unpackedSize += BigInt(bytes.length)
    processed.value += BigInt(bytes.length)
    options.onProgress?.(processed.value, entry.path)
    if (method === 'copy') {
      await emit(bytes)
      return
    }

    const joined = pending.length === 0 ? bytes : concatBytes([pending, bytes])
    let offset = 0
    while (joined.length - offset >= LZMA2_ENCODE_CHUNK_SIZE) {
      const chunk = joined.subarray(offset, offset + LZMA2_ENCODE_CHUNK_SIZE)
      const encoded = options.encodeLzma2Chunk
        ? await options.encodeLzma2Chunk(chunk, options.signal)
        : encodeLzma2Block(chunk, options.lzmaEncoder)
      await emit(encoded.data)
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
      await emit(encoded.data)
    }
    await emit(Uint8Array.of(0))
  }

  if (aes) {
    const trailer = await aes.encryptor.final()
    if (trailer.length > 0) await sink.write(trailer, options.signal)
    packedSize = aes.encryptor.cipherSize
  }

  return {
    packedSize,
    unpackedSize,
    crc: crc.digest(),
    method,
    ...(method === 'lzma2' ? { dictionaryProperty } : {}),
    ...(aes ? { aes: { properties: aes.properties, codedSize: aes.encryptor.plainSize } } : {})
  }
}

async function consumeSolidEntries(
  entries: readonly SevenZipEntryInput[],
  sink: SeekableSink,
  dictionaryProperty: number,
  options: CreateSevenZipOptions,
  processed: { value: bigint },
  encryption?: ArchiveEncryption
): Promise<WrittenStream> {
  const substreams: Array<{ size: bigint; crc: number }> = []
  const totalSize = entries.reduce((total, entry) => total + entry.size, 0n)
  let iterator: AsyncGenerator<Uint8Array> | null = null

  const combined: SevenZipEntryInput = {
    path: entries[0]?.path ?? 'solid-block',
    size: totalSize,
    open: () => {
      iterator = (async function* () {
        for (const entry of entries) {
          if (!entry.open) throw new TypeError(`File entry has no content stream: ${entry.path}`)
          const reader = entry.open().getReader()
          const digest = new Crc32()
          let size = 0n
          try {
            while (true) {
              throwIfCancelled(options.signal)
              const item = await reader.read()
              if (item.done) break
              if (!(item.value instanceof Uint8Array)) {
                throw new TypeError(`Entry stream did not yield Uint8Array: ${entry.path}`)
              }
              digest.update(item.value)
              size += BigInt(item.value.length)
              yield item.value
            }
          } finally {
            reader.releaseLock()
          }
          if (size !== entry.size) {
            throw new Libera7zError(
              'INVALID_ARCHIVE',
              `Entry ${entry.path} yielded ${size} bytes but declared ${entry.size}`
            )
          }
          substreams.push({ size, crc: digest.digest() })
        }
      })()
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const item = await iterator!.next()
          if (item.done) controller.close()
          else controller.enqueue(item.value)
        },
        async cancel() {
          await iterator?.return(undefined)
        }
      })
    }
  }

  const written = await consumeEntry(
    combined,
    sink,
    'lzma2',
    dictionaryProperty,
    options,
    processed,
    encryption
  )
  return { ...written, substreams }
}

/**
 * Writes the plain header as one more packed stream, encrypted, and returns the
 * EncodedHeader descriptor that replaces it. 7-Zip does the same with a single
 * AES coder and no compression, so the descriptor stays small enough that
 * skipping LZMA2 here costs nothing.
 *
 * The folder CRC has to live in UnpackInfo: `decodeEncodedHeader` reads
 * `folder.crc`, which only `parseUnpackInfo` sets, and without it a wrong
 * password would surface as a garbage header parse instead of WRONG_PASSWORD.
 */
async function writeEncryptedHeader(
  header: Uint8Array,
  sink: SeekableSink,
  encryption: ArchiveEncryption,
  options: CreateSevenZipOptions
): Promise<Uint8Array> {
  const packPosition = sink.position - BigInt(SIGNATURE_HEADER_SIZE)
  const aes = await beginEncryption(encryption)
  const body = await aes.encryptor.update(header)
  if (body.length > 0) await sink.write(body, options.signal)
  const trailer = await aes.encryptor.final()
  if (trailer.length > 0) await sink.write(trailer, options.signal)

  const writer = new ByteWriter().byte(NID.EncodedHeader)
  writer.byte(NID.PackInfo)
    .variableUint64(packPosition)
    .variableUint64(1n)
    .byte(NID.Size)
    .variableUint64(aes.encryptor.cipherSize)
    .byte(NID.End)
  writer.byte(NID.UnpackInfo)
    .byte(NID.Folder)
    .variableUint64(1n)
    .byte(0)
  writer.variableUint64(1n)
  writeAesCoder(writer, aes.properties)
  writer.byte(NID.CodersUnpackSize).variableUint64(BigInt(header.length))
  writer.byte(NID.CRC).byte(1).uint32(crc32(header))
  writer.byte(NID.End)
  writer.byte(NID.End)
  return writer.build()
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
  const password = options.password === '' ? undefined : options.password
  if (options.encryptHeader && password === undefined) {
    throw new Libera7zError('UNSUPPORTED_FEATURE', 'Encrypting the 7z header needs a password')
  }
  const randomBytes = options.randomBytes ?? defaultRandomBytes
  // One derivation per archive: the salt is archive-wide and the loop runs
  // 2^19 rounds, so paying it per folder would dominate the whole job.
  const encryption: ArchiveEncryption | undefined = password === undefined ? undefined : (() => {
    const properties = generateSevenZipAesProperties(randomBytes)
    return {
      key: deriveSevenZipAesKey(password, properties, options.signal),
      cyclesPower: properties.cyclesPower,
      salt: properties.salt,
      randomBytes
    }
  })()
  const streams: WrittenStream[] = []
  const processed = { value: 0n }
  let closed = false

  try {
    await sink.write(new Uint8Array(SIGNATURE_HEADER_SIZE), options.signal)
    const dataEntries = entries.filter(entry => !entry.isDirectory && entry.size > 0n)
    if (options.solid && method === 'lzma2' && dataEntries.length > 1) {
      streams.push(await consumeSolidEntries(
        dataEntries, sink, dictionaryProperty, options, processed, encryption
      ))
    } else {
      for (const entry of dataEntries) {
        throwIfCancelled(options.signal)
        streams.push(await consumeEntry(entry, sink, method, dictionaryProperty, options, processed, encryption))
      }
    }
    const header = buildNextHeader(entries, streams)
    const nextHeader = encryption && options.encryptHeader
      ? await writeEncryptedHeader(header, sink, encryption, options)
      : header
    const nextHeaderOffset = sink.position - BigInt(SIGNATURE_HEADER_SIZE)
    await sink.write(nextHeader, options.signal)
    await sink.writeAt(0n, signatureHeader(nextHeaderOffset, nextHeader), options.signal)
    await sink.close()
    closed = true
    return { size: sink.position, headerSize: nextHeader.length }
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
  if (numCoders < 1) throw invalidArchive('7z folder has no coders')
  const coders: ParsedCoder[] = []
  let totalInputs = 0
  let totalOutputs = 0
  for (let coderIndex = 0; coderIndex < numCoders; coderIndex += 1) {
    const flags = reader.byte()
    if ((flags & 0x80) !== 0) throw unsupportedFeature('Alternative 7z coder methods are unsupported')
    const methodId = readMethodId(reader, flags & 0x0f)
    const complex = (flags & 0x10) !== 0
    const inputStreams = complex ? reader.safeNumber('7z coder input count') : 1
    const outputStreams = complex ? reader.safeNumber('7z coder output count') : 1
    if (inputStreams < 1 || outputStreams < 1) throw invalidArchive('7z coder has no input or output stream')
    const properties = (flags & 0x20) !== 0
      ? reader.read(reader.safeNumber('7z coder properties size')).slice()
      : new Uint8Array(0)
    if (methodId === COPY_METHOD && properties.length !== 0) throw invalidArchive('Copy coder has unexpected properties')
    if (methodId === LZMA2_METHOD && properties.length !== 1) throw invalidArchive('LZMA2 coder properties are malformed')
    if (methodId === LZMA_METHOD) parseLzma1Properties(properties)
    if (methodId === PPMD_METHOD) parsePpmd7Properties(properties)
    if ((methodId === DEFLATE_METHOD || methodId === DEFLATE64_METHOD) && properties.length !== 0) {
      throw invalidArchive('DEFLATE coder has unexpected properties')
    }
    if (methodId === BZIP2_METHOD && properties.length !== 0) throw invalidArchive('BZip2 coder has unexpected properties')
    if (methodId === AES_METHOD) parseSevenZipAesProperties(properties)
    coders.push({
      methodId,
      properties,
      inputStreams,
      outputStreams,
      inputStart: totalInputs,
      outputStart: totalOutputs
    })
    totalInputs += inputStreams
    totalOutputs += outputStreams
  }

  if (totalOutputs < 1 || totalInputs < totalOutputs - 1) throw invalidArchive('Invalid 7z folder stream counts')
  const bindPairs = Array.from({ length: totalOutputs - 1 }, (): ParsedBindPair => ({
    inputIndex: reader.safeNumber('7z bind input index'),
    outputIndex: reader.safeNumber('7z bind output index')
  }))
  const boundInputs = new Set<number>()
  const boundOutputs = new Set<number>()
  for (const pair of bindPairs) {
    if (pair.inputIndex >= totalInputs || pair.outputIndex >= totalOutputs) {
      throw invalidArchive('7z folder bind pair is out of range')
    }
    if (boundInputs.has(pair.inputIndex) || boundOutputs.has(pair.outputIndex)) {
      throw invalidArchive('7z folder binds a stream more than once')
    }
    boundInputs.add(pair.inputIndex)
    boundOutputs.add(pair.outputIndex)
  }

  const packedStreamCount = totalInputs - bindPairs.length
  if (packedStreamCount < 1) throw invalidArchive('7z folder has no packed input stream')
  let packedIndices: number[]
  if (packedStreamCount === 1) {
    const inputIndex = Array.from({ length: totalInputs }, (_, index) => index)
      .find(index => !boundInputs.has(index))
    if (inputIndex === undefined) throw invalidArchive('7z folder has no unbound packed input')
    packedIndices = [inputIndex]
  } else {
    packedIndices = Array.from({ length: packedStreamCount }, () =>
      reader.safeNumber('7z packed input index'))
    const unique = new Set(packedIndices)
    if (
      unique.size !== packedIndices.length ||
      packedIndices.some(index => index >= totalInputs || boundInputs.has(index))
    ) {
      throw invalidArchive('7z folder packed input indices are invalid')
    }
  }

  const finalOutputs = Array.from({ length: totalOutputs }, (_, index) => index)
    .filter(index => !boundOutputs.has(index))
  if (finalOutputs.length !== 1) throw invalidArchive('7z folder does not have one final output stream')
  return {
    coders,
    bindPairs,
    packedIndices,
    unpackSizes: [],
    finalOutputIndex: finalOutputs[0],
    unpackSize: 0n,
    packIndex
  }
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
  let packIndex = 0
  const folders = Array.from({ length: count }, () => {
    const folder = parseFolder(reader, packIndex)
    packIndex += folder.packedIndices.length
    return folder
  })
  if (packIndex !== packStreamCount) throw invalidArchive('7z folder packed streams do not match PackInfo')
  if (reader.byte() !== NID.CodersUnpackSize) throw invalidArchive('7z folder sizes are missing')
  for (const folder of folders) {
    const outputCount = folder.coders.reduce((total, coder) => total + coder.outputStreams, 0)
    folder.unpackSizes = Array.from({ length: outputCount }, () => reader.variableUint64())
    folder.unpackSize = folder.unpackSizes[folder.finalOutputIndex]
  }
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
  const expectedPackStreams = folders.reduce((total, folder) => total + folder.packedIndices.length, 0)
  if (packSizes.length !== expectedPackStreams) throw invalidArchive('7z stream and folder counts do not match')
  const packedOffsets: bigint[] = []
  let packedOffset = 32n + packPosition
  for (const size of packSizes) {
    packedOffsets.push(packedOffset)
    packedOffset += size
  }
  folders.forEach(folder => {
    folder.packedOffsets = folder.packedIndices.map((_, index) => packedOffsets[folder.packIndex + index])
    folder.packedSizes = folder.packedIndices.map((_, index) => packSizes[folder.packIndex + index])
    folder.substreams ??= [{ size: folder.unpackSize, crc: folder.crc }]
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
      if (substreamIndex === 0) {
        packedSize = folder.packedSizes?.reduce((total, value) => total + value, 0n)
      }
    }
    const rawAttributes = attributes[index]
    const unixMode = rawAttributes === undefined ? undefined : (rawAttributes >>> 16) & 0xffff
    const unixType = unixMode === undefined ? 0 : unixMode & 0o170000
    const isSymlink = unixType === 0o120000
    if (unixType !== 0 && unixType !== 0o040000 && unixType !== 0o100000 && !isSymlink) {
      throw unsupportedFeature('Special-file entries are not supported')
    }
    return {
      path,
      isDirectory,
      size,
      modified: modified[index],
      mode: unixMode === undefined ? undefined : unixMode & 0o7777,
      isSymlink,
      encrypted: folder?.coders.some(coder => coder.methodId === AES_METHOD) === true,
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
  decodeBuffer?: OpenSevenZipOptions['decodeLzma2Buffer'],
  decryption: DecryptionContext = decryptionContext()
): Promise<Uint8Array> {
  const reader = new ByteReader(bytes)
  if (reader.byte() !== NID.EncodedHeader) throw invalidArchive('Invalid encoded-header marker')
  const streams = parseStreamsInfo(reader)
  reader.assertFinished('encoded 7z header descriptor')
  if (streams.folders.length !== 1 || streams.folders[0].substreams?.length !== 1) {
    throw unsupportedFeature('Only one-stream encoded 7z headers are supported')
  }
  const folder = streams.folders[0]
  const packedSize = streams.packSizes.reduce((total, size) => total + size, 0n)
  if (packedSize > BigInt(MAX_ENCODED_HEADER_SIZE) || folder.unpackSize > BigInt(MAX_ENCODED_HEADER_SIZE)) {
    throw new Libera7zError('LIMIT_EXCEEDED', 'Encoded 7z header exceeds the 64 MiB limit')
  }
  const encrypted = folder.coders.some(coder => coder.methodId === AES_METHOD)
  const decoded = await decodeFolderBuffer(source, folder, signal, decodeBuffer, decryption)
  if (folder.crc !== undefined && crc32(decoded) !== folder.crc) {
    if (decryption.password !== undefined && encrypted) {
      throw new Libera7zError('WRONG_PASSWORD', 'The 7z archive password is incorrect')
    }
    throw new Libera7zError('CRC_MISMATCH', 'Encoded 7z header CRC does not match')
  }
  // A header that decrypted to a matching digest settles the password.
  if (encrypted && folder.crc !== undefined) decryption.verified = true
  return decoded
}

function linearCoderOrder(folder: ParsedFolder): ParsedCoder[] | null {
  if (folder.packedIndices.length !== 1 || folder.coders.some(coder => coder.inputStreams !== 1 || coder.outputStreams !== 1)) {
    return null
  }
  const byInput = new Map(folder.coders.map(coder => [coder.inputStart, coder]))
  const bindByOutput = new Map(folder.bindPairs.map(pair => [pair.outputIndex, pair.inputIndex]))
  const order: ParsedCoder[] = []
  const seen = new Set<ParsedCoder>()
  let inputIndex = folder.packedIndices[0]
  while (true) {
    const coder = byInput.get(inputIndex)
    if (!coder || seen.has(coder)) return null
    order.push(coder)
    seen.add(coder)
    const nextInput = bindByOutput.get(coder.outputStart)
    if (nextInput === undefined) break
    inputIndex = nextInput
  }
  return seen.size === folder.coders.length && order.at(-1)!.outputStart === folder.finalOutputIndex
    ? order
    : null
}

async function decodeFolderBuffer(
  source: RandomAccessSource,
  folder: ParsedFolder,
  signal?: AbortSignal,
  decodeLzma2Buffer?: OpenSevenZipOptions['decodeLzma2Buffer'],
  decryption: DecryptionContext = decryptionContext()
): Promise<Uint8Array> {
  if (!folder.packedOffsets || !folder.packedSizes) throw invalidArchive('7z folder has no packed stream')
  const packedInputs = new Map<number, Uint8Array>()
  for (let index = 0; index < folder.packedIndices.length; index += 1) {
    packedInputs.set(folder.packedIndices[index], await readExactly(
      source,
      folder.packedOffsets[index],
      uint64ToSafeNumber(folder.packedSizes[index], '7z packed stream size'),
      signal
    ))
  }
  const boundInputToOutput = new Map(folder.bindPairs.map(pair => [pair.inputIndex, pair.outputIndex]))
  const coderByOutput = new Map<number, ParsedCoder>()
  for (const coder of folder.coders) {
    for (let index = 0; index < coder.outputStreams; index += 1) coderByOutput.set(coder.outputStart + index, coder)
  }
  const decodedOutputs = new Map<number, Promise<Uint8Array>>()
  const visiting = new Set<number>()
  const encrypted = folder.coders.some(coder => coder.methodId === AES_METHOD)

  const decodeOutput = (outputIndex: number): Promise<Uint8Array> => {
    const existing = decodedOutputs.get(outputIndex)
    if (existing) return existing
    const pending = (async () => {
      if (visiting.has(outputIndex)) throw invalidArchive('7z coder graph contains a cycle')
      visiting.add(outputIndex)
      try {
        const coder = coderByOutput.get(outputIndex)
        if (!coder) throw invalidArchive('7z coder graph references a missing output')
        if (coder.outputStreams !== 1 || outputIndex !== coder.outputStart) {
          throw unsupportedFeature('Multi-output 7z coders are unsupported')
        }
        const inputs: Uint8Array[] = []
        for (let index = 0; index < coder.inputStreams; index += 1) {
          const inputIndex = coder.inputStart + index
          const packed = packedInputs.get(inputIndex)
          if (packed) {
            inputs.push(packed)
            continue
          }
          const boundOutput = boundInputToOutput.get(inputIndex)
          if (boundOutput === undefined) throw invalidArchive('7z coder input is neither packed nor bound')
          inputs.push(await decodeOutput(boundOutput))
        }
        const outputSize = uint64ToSafeNumber(folder.unpackSizes[coder.outputStart], '7z coder output size')
        if (coder.methodId === BCJ2_METHOD) return decodeBcj2(inputs, coder.properties, outputSize, signal)
        if (inputs.length !== 1) throw unsupportedFeature('Unsupported multi-input 7z coder')
        let value = inputs[0]
        if (coder.methodId === COPY_METHOD) {
          if (value.length !== outputSize) throw invalidArchive('Copy stream size does not match the 7z folder size')
        } else if (coder.methodId === LZMA2_METHOD && coder.properties.length === 1) {
          value = await decodeLzma2Buffer?.(value, coder.properties[0], outputSize, signal) ??
            decodeLzma2(value, coder.properties[0], outputSize, signal)
        } else if (coder.methodId === LZMA_METHOD) {
          value = decodeLzma1(value, coder.properties, outputSize, signal)
        } else if (coder.methodId === PPMD_METHOD) {
          value = decodePpmd7(value, coder.properties, outputSize, signal)
        } else if (coder.methodId === DEFLATE_METHOD || coder.methodId === DEFLATE64_METHOD) {
          value = inflateRaw(value, outputSize, coder.methodId === DEFLATE64_METHOD, signal)
        } else if (coder.methodId === BZIP2_METHOD) {
          value = decodeBzip2(value, outputSize, signal)
        } else if (SIMPLE_FILTERS.has(coder.methodId)) {
          if (value.length !== outputSize) throw invalidArchive('7z filter changed the declared stream size')
          value = decodeSevenZipFilter(SIMPLE_FILTERS.get(coder.methodId)!, value, coder.properties, signal)
        } else if (coder.methodId === AES_METHOD) {
          value = await decryptSevenZipAes(
            value, coder.properties, decryption.password, outputSize, signal, decryption.deriveKey
          )
        } else {
          throw new Libera7zError('UNSUPPORTED_METHOD', `Unsupported 7z coder: 0x${coder.methodId.toString(16)}`)
        }
        return value
      } finally {
        visiting.delete(outputIndex)
      }
    })()
    decodedOutputs.set(outputIndex, pending)
    return pending
  }

  try {
    const value = await decodeOutput(folder.finalOutputIndex)
    if (value.length !== uint64ToSafeNumber(folder.unpackSize, '7z folder output size')) {
      throw invalidArchive('7z coder graph output size does not match the folder')
    }
    return value
  } catch (error) {
    throw asPasswordFailure(error, encrypted, decryption)
  }
}

/** The slice of `PackedCursor` the LZMA2 stream decoder actually consumes,
 * so a decrypting cursor can stand in for it. */
interface PackedByteCursor {
  readonly remaining: bigint
  read(length: number): Promise<Uint8Array>
  byte(): Promise<number>
}

class PackedCursor implements PackedByteCursor {
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

const AES_DECRYPT_RUN_SIZE = 256 * 1024

/**
 * Decrypts a packed AES stream on the fly so the coders above it keep
 * streaming. `remaining` counts plaintext, which is what the callers compare
 * against the declared coder output; the trailing zero padding is never handed
 * out. Each run is decrypted into a fresh buffer because callers hold on to
 * what they are given across awaits.
 */
class AesDecryptingCursor implements PackedByteCursor {
  private run: Uint8Array = new Uint8Array(0)
  private runOffset = 0
  private produced = 0n

  private constructor(
    private readonly cursor: PackedCursor,
    private readonly cryptoKey: CryptoKey,
    private iv: Uint8Array,
    private readonly outputSize: bigint,
    private readonly signal?: AbortSignal
  ) {}

  static async create(
    source: RandomAccessSource,
    start: bigint,
    packedSize: bigint,
    coder: ParsedCoder,
    outputSize: bigint,
    password: string | undefined,
    deriveKey: SevenZipAesKeyDeriver,
    signal?: AbortSignal
  ): Promise<AesDecryptingCursor> {
    if (password === undefined) throw new Libera7zError('PASSWORD_REQUIRED', 'The 7z archive needs a password')
    if ((packedSize & 15n) !== 0n) throw invalidArchive('7zAES packed stream is not block aligned')
    if (outputSize > packedSize) throw invalidArchive('7zAES output size is invalid')
    const properties = parseSevenZipAesProperties(coder.properties)
    const key = deriveKey(password, properties, signal)
    try {
      return new AesDecryptingCursor(
        new PackedCursor(source, start, packedSize, signal),
        await importSevenZipAesKey(key),
        properties.iv.slice(),
        outputSize,
        signal
      )
    } finally {
      key.fill(0)
    }
  }

  get remaining(): bigint {
    return this.outputSize - this.produced
  }

  async read(length: number): Promise<Uint8Array> {
    if (BigInt(length) > this.remaining) throw invalidArchive('7zAES stream is truncated')
    this.produced += BigInt(length)
    const available = this.run.length - this.runOffset
    if (available >= length) {
      const value = this.run.subarray(this.runOffset, this.runOffset + length)
      this.runOffset += length
      return value
    }
    const value = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      if (this.runOffset === this.run.length) await this.fill()
      const take = Math.min(length - offset, this.run.length - this.runOffset)
      value.set(this.run.subarray(this.runOffset, this.runOffset + take), offset)
      this.runOffset += take
      offset += take
    }
    return value
  }

  async byte(): Promise<number> {
    return (await this.read(1))[0]
  }

  private async fill(): Promise<void> {
    throwIfCancelled(this.signal)
    const length = Number(this.cursor.remaining < BigInt(AES_DECRYPT_RUN_SIZE)
      ? this.cursor.remaining
      : BigInt(AES_DECRYPT_RUN_SIZE))
    if (length === 0) throw invalidArchive('7zAES stream is truncated')
    const block = await this.cursor.read(length)
    this.run = await decryptAesCbcRaw(this.cryptoKey, this.iv, block)
    this.iv = block.slice(block.length - 16)
    this.runOffset = 0
  }
}

async function* decodeLzma2FromSource(
  cursor: PackedByteCursor,
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
  const state = initialLzma2ChunkState()

  try {
    while (true) {
      throwIfCancelled(signal)
      const control = await cursor.byte()
      const plan = planLzma2Chunk(control, state)
      if (plan.kind === 'end') break
      if (plan.resetDictionary) await decoder.resetDictionary()

      if (plan.kind === 'uncompressed') {
        const length = (((await cursor.byte()) << 8) | await cursor.byte()) + 1
        const bytes = await cursor.read(length)
        await decoder.writeUncompressed(bytes)
        total += BigInt(bytes.length)
        yield bytes
        continue
      }

      const unpacked = (((control & 0x1f) << 16) | ((await cursor.byte()) << 8) | await cursor.byte()) + 1
      const packed = (((await cursor.byte()) << 8) | await cursor.byte()) + 1
      if (plan.readProperties) await decoder.setProperties(await cursor.byte())
      if (plan.resetState) await decoder.resetState()

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

/**
 * Memoises the 7zAES key derivation for one archive. The loop runs 2^19 SHA-256
 * rounds and every folder repeats it, so a non-solid archive of N entries paid
 * it N times. Salt and cycle count are archive-wide, so one entry suffices;
 * copies are handed out because callers zero what they are given.
 */
function memoiseKeyDerivation(): SevenZipAesKeyDeriver {
  const cache = new Map<string, Uint8Array>()
  return (password, properties, signal) => {
    const key = `${properties.cyclesPower}:${Array.from(properties.salt).join(',')}`
    const existing = cache.get(key)
    if (existing) return existing.slice()
    const derived = deriveSevenZipAesKey(password, properties, signal)
    cache.set(key, derived.slice())
    return derived
  }
}

/**
 * Password state for one archive's decoding.
 *
 * A wrong password turns ciphertext into noise, and the coder above AES fails
 * in whatever way that noise happens to break it, so an unverified password
 * has to absorb almost any error. `verified` flips as soon as something proves
 * the password right - a decrypted header, or a substream whose CRC matched -
 * after which failures are reported as themselves. Without that, a decoder bug
 * or a corrupt archive masquerades as a bad password and sends the user
 * retyping a password that was always correct.
 */
interface DecryptionContext {
  password?: string
  deriveKey: SevenZipAesKeyDeriver
  verified: boolean
}

function decryptionContext(password?: string): DecryptionContext {
  return { password, deriveKey: memoiseKeyDerivation(), verified: false }
}

function isWrongPasswordFailure(error: unknown): boolean {
  return !(error instanceof Libera7zError && ['CANCELLED', 'LIMIT_EXCEEDED', 'UNSUPPORTED_METHOD'].includes(error.code))
}

function asPasswordFailure(error: unknown, encrypted: boolean, decryption: DecryptionContext): unknown {
  if (encrypted && decryption.password !== undefined && !decryption.verified && isWrongPasswordFailure(error)) {
    return new Libera7zError('WRONG_PASSWORD', 'The 7z archive password is incorrect')
  }
  return error
}

async function* classifyPasswordFailures(
  encrypted: boolean,
  decryption: DecryptionContext,
  body: () => AsyncGenerator<Uint8Array>
): AsyncGenerator<Uint8Array> {
  try {
    yield* body()
  } catch (error) {
    throw asPasswordFailure(error, encrypted, decryption)
  }
}

async function* decodeFolderFromSource(
  source: RandomAccessSource,
  folder: ParsedFolder,
  signal?: AbortSignal,
  decoderFactory?: OpenSevenZipOptions['lzma2DecoderFactory'],
  decodeBuffer?: OpenSevenZipOptions['decodeLzma2Buffer'],
  decryption: DecryptionContext = decryptionContext()
): AsyncGenerator<Uint8Array> {
  if (!folder.packedOffsets || !folder.packedSizes) {
    throw invalidArchive('7z folder has no packed stream')
  }
  const order = linearCoderOrder(folder)
  const single = folder.packedOffsets.length === 1
  // An encrypted folder reads as [AES, …]: decrypt into a cursor and let the
  // coder above it stream as usual, rather than buffering the whole entry.
  const aes = single && order?.[0]?.methodId === AES_METHOD ? order[0] : undefined
  const coder = order?.length === (aes ? 2 : 1) ? order.at(-1) : undefined
  if (coder && (coder === aes || coder.methodId === COPY_METHOD ||
      (coder.methodId === LZMA2_METHOD && coder.properties.length === 1))) {
    const cursor = aes
      ? await AesDecryptingCursor.create(
        source,
        folder.packedOffsets[0],
        folder.packedSizes[0],
        aes,
        folder.unpackSizes[aes.outputStart],
        decryption.password,
        decryption.deriveKey,
        signal
      )
      : new PackedCursor(source, folder.packedOffsets[0], folder.packedSizes[0], signal)
    // The classifier decodeFolderBuffer applies, repeated here because a wrong
    // password only shows up once the coder above chokes on the garbage.
    yield* classifyPasswordFailures(aes !== undefined, decryption, async function* () {
      if (coder.methodId === LZMA2_METHOD) {
        for await (const decoded of decodeLzma2FromSource(
            cursor,
            coder.properties[0],
            folder.unpackSize,
            signal,
            decoderFactory
          )) {
          for (let offset = 0; offset < decoded.length; offset += 256 * 1024) {
            yield decoded.subarray(offset, Math.min(decoded.length, offset + 256 * 1024))
          }
        }
        return
      }
      let remaining = folder.unpackSize
      while (remaining > 0n) {
        throwIfCancelled(signal)
        const length = Number(remaining > 1024n * 1024n ? 1024n * 1024n : remaining)
        const bytes = await cursor.read(length)
        remaining -= BigInt(bytes.length)
        yield bytes
      }
      if (cursor.remaining !== 0n) throw invalidArchive('Copy stream size does not match the 7z folder size')
    })
    return
  }
  const decoded = await decodeFolderBuffer(source, folder, signal, decodeBuffer, decryption)
  for (let offset = 0; offset < decoded.length; offset += 1024 * 1024) {
    throwIfCancelled(signal)
    yield decoded.subarray(offset, Math.min(decoded.length, offset + 1024 * 1024))
  }
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
    private readonly decoderFactory?: OpenSevenZipOptions['lzma2DecoderFactory'],
    private readonly decodeBuffer?: OpenSevenZipOptions['decodeLzma2Buffer'],
    private readonly decryption: DecryptionContext = decryptionContext(),
    readonly metadata: SevenZipArchiveMetadata = {
      version: '0.4',
      nextHeaderOffset: 0n,
      nextHeaderSize: 0n
    }
  ) {
    this.entries = parsedFiles.map((file, id) => ({
      id,
      path: file.path,
      size: file.size,
      packedSize: file.packedSize,
      isDirectory: file.isDirectory,
      encrypted: file.encrypted,
      isSymlink: file.isSymlink,
      modified: file.modified,
      mode: file.mode,
      crc: file.crc,
      codec: folderCodec(file.folder),
      dictionarySize: folderDictionarySize(file.folder),
      solid: (file.folder?.substreams?.length ?? 0) > 1
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
    const decodeBuffer = this.decodeBuffer
    const decryption = this.decryption
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
              decodeFolderFromSource(
                source,
                file.folder,
                options.signal,
                decoderFactory,
                decodeBuffer,
                decryption
              ),
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
          // Reaching the end of a substream with its digest intact settles the
          // password, so anything that fails later is a real fault.
          if (substream.crc !== undefined) decryption.verified = true
          yield { type: 'entry-end', entry }
        }
      } catch (error) {
        if (
          !decryption.verified &&
          decryption.password !== undefined &&
          activeFolder?.coders.some(coder => coder.methodId === AES_METHOD) &&
          error instanceof Libera7zError &&
          (error.code === 'CRC_MISMATCH' || error.code === 'INVALID_ARCHIVE')
        ) {
          throw new Libera7zError('WRONG_PASSWORD', 'The 7z archive password is incorrect')
        }
        throw error
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
  // One context for the header and every folder: the key derivation is by far
  // the most expensive part of opening the archive, and whatever the header
  // proves about the password carries over to the data.
  const decryption = decryptionContext(options.password)
  const encodedHeader = nextHeader[0] === NID.EncodedHeader
  const decoded = encodedHeader
    ? await decodeEncodedHeader(source, nextHeader, options.signal, options.decodeLzma2Buffer, decryption)
    : nextHeader
  // Not every writer puts a CRC on the encrypted header - py7zr omits it - so a
  // wrong password can reach this point as nonsense bytes rather than a digest
  // mismatch. Reading them as corruption would send the user hunting a broken
  // file instead of retyping the password.
  const files = encodedHeader && options.password !== undefined
    ? (() => {
      try {
        return parseHeader(decoded)
      } catch (error) {
        throw asPasswordFailure(error, true, decryption)
      }
    })()
    : parseHeader(decoded)
  // Header bytes that parse as a 7z header are not something a wrong password
  // produces, so the password is settled even when no digest was stored.
  if (encodedHeader) decryption.verified = true
  if (options.maxEntries !== undefined && files.length > options.maxEntries) {
    throw new Libera7zError('LIMIT_EXCEEDED', '7z archive contains too many entries')
  }
  const dictionaryLimit = options.maxDictionaryBytes ?? 256 * 1024 * 1024
  for (const file of files) {
    for (const coder of file.folder?.coders ?? []) {
      let dictionarySize: number | undefined
      if (coder.methodId === LZMA2_METHOD) dictionarySize = dictionarySizeFromProperty(coder.properties[0])
      else if (coder.methodId === LZMA_METHOD) dictionarySize = parseLzma1Properties(coder.properties).dictionarySize
      else if (coder.methodId === PPMD_METHOD) dictionarySize = parsePpmd7Properties(coder.properties).memorySize
      if (dictionarySize !== undefined && dictionarySize > dictionaryLimit) {
        throw new Libera7zError('LIMIT_EXCEEDED', `7z dictionary exceeds the ${dictionaryLimit}-byte limit`)
      }
    }
  }
  return new SevenZipArchive(
    source,
    files,
    options.lzma2DecoderFactory,
    options.decodeLzma2Buffer,
    decryption,
    {
      version: `${signature[6]}.${signature[7]}`,
      nextHeaderOffset: nextOffset,
      nextHeaderSize: nextSize
    }
  )
}
