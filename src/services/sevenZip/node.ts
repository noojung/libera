import fs, { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import path from 'path'
import {
  Libera7zError,
  create7z,
  open7z,
  type CreateSevenZipOptions,
  type OpenSevenZipOptions,
  type RandomAccessSource,
  type SeekableSink,
  planSevenZipEntries,
  sevenZipSolidRuns,
  type SevenZipEntryInput,
  type SevenZipMethod,
  type SevenZipReader
} from 'libera7z'
import './workerSetup'
import {
  discoverSevenZipVolumes,
  isSevenZipVolumePath,
  MAX_SEVEN_ZIP_VOLUMES,
  removeStaleSevenZipVolumes,
  sevenZipVolumePath
} from './volumes'
import {
  resolveSevenZipMethod,
  type SevenZipCompressionLevel,
  type SevenZipMethodOverride
} from './methodOverrides'

async function writeFully(
  handle: fsPromises.FileHandle,
  offset: bigint,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> {
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('7z output offset exceeds Node.js safe range')
  let written = 0
  while (written < bytes.length) {
    if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
    const result = await handle.write(bytes, written, bytes.length - written, Number(offset) + written)
    if (result.bytesWritten === 0) throw new Error('Unable to make progress writing the 7z archive')
    written += result.bytesWritten
  }
}

class NodeFileSource implements RandomAccessSource {
  private constructor(
    private readonly handle: fsPromises.FileHandle,
    readonly size: bigint
  ) {}

  static async open(filePath: string): Promise<NodeFileSource> {
    const handle = await fsPromises.open(filePath, 'r')
    try {
      const stat = await handle.stat({ bigint: true })
      return new NodeFileSource(handle, stat.size)
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
    const buffer = Buffer.allocUnsafe(length)
    let read = 0
    while (read < length) {
      const result = await this.handle.read(buffer, read, length - read, offset + BigInt(read))
      if (result.bytesRead === 0) break
      read += result.bytesRead
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read).slice()
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}

class NodeFileSink implements SeekableSink {
  private cursor = 0n
  private closed = false

  private constructor(private readonly handle: fsPromises.FileHandle) {}

  static async open(filePath: string): Promise<NodeFileSink> {
    return new NodeFileSink(await fsPromises.open(filePath, 'w'))
  }

  get position(): bigint {
    return this.cursor
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await writeFully(this.handle, this.cursor, bytes, signal)
    this.cursor += BigInt(bytes.length)
  }

  async writeAt(offset: bigint, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (offset < 0n || offset + BigInt(bytes.length) > this.cursor) throw new RangeError('7z patch is outside the file')
    await writeFully(this.handle, offset, bytes, signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close()
  }
}

interface OpenVolume {
  path: string
  start: bigint
  end: bigint
}

/** Presents numbered 7z volumes as the one continuous byte stream they split. */
class NodeVolumeSource implements RandomAccessSource {
  private closed = false
  private current: { path: string; handle: fsPromises.FileHandle } | null = null
  private pending: Promise<void> = Promise.resolve()

  private constructor(
    private readonly volumes: readonly OpenVolume[],
    readonly size: bigint
  ) {}

  static async open(volumePaths: readonly string[]): Promise<NodeVolumeSource> {
    const volumes: OpenVolume[] = []
    let size = 0n
    for (const volumePath of volumePaths) {
      const stat = await fsPromises.stat(volumePath, { bigint: true })
      volumes.push({ path: volumePath, start: size, end: size + stat.size })
      size += stat.size
    }
    return new NodeVolumeSource(volumes, size)
  }

  private async handleFor(volumePath: string): Promise<fsPromises.FileHandle> {
    if (this.current?.path === volumePath) return this.current.handle
    await this.current?.handle.close()
    this.current = { path: volumePath, handle: await fsPromises.open(volumePath, 'r') }
    return this.current.handle
  }

  private async readSerial(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closed) throw new Error('7z volume source is closed')
    if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
    if (offset < 0n || !Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid 7z volume read')
    const buffer = Buffer.allocUnsafe(length)
    let outputOffset = 0
    let archiveOffset = offset

    for (const volume of this.volumes) {
      if (outputOffset === length) break
      if (archiveOffset >= volume.end) continue
      if (archiveOffset < volume.start) archiveOffset = volume.start
      const localOffset = archiveOffset - volume.start
      const available = volume.end - archiveOffset
      const requested = Math.min(length - outputOffset, Number(available))
      let volumeRead = 0
      const handle = await this.handleFor(volume.path)
      while (volumeRead < requested) {
        if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
        const result = await handle.read(
          buffer,
          outputOffset + volumeRead,
          requested - volumeRead,
          localOffset + BigInt(volumeRead)
        )
        if (result.bytesRead === 0) break
        volumeRead += result.bytesRead
      }
      outputOffset += volumeRead
      archiveOffset += BigInt(volumeRead)
      if (volumeRead !== requested) break
    }

    return new Uint8Array(buffer.buffer, buffer.byteOffset, outputOffset).slice()
  }

  read(offset: bigint, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const result = this.pending.then(() => this.readSerial(offset, length, signal))
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pending
    await this.current?.handle.close()
    this.current = null
  }
}

/** Splits an ordinary 7z byte stream into the `.001`, `.002`, ... files. */
class NodeVolumeSink implements SeekableSink {
  private readonly splitSizeBigInt: bigint
  private cursor = 0n
  private currentHandle: fsPromises.FileHandle | null = null
  private currentVolumeIndex = -1
  private closed = false
  readonly volumePaths: string[] = []

  constructor(
    private readonly outputPath: string,
    private readonly splitSize: number
  ) {
    if (!Number.isSafeInteger(splitSize) || splitSize < 1) throw new RangeError('Invalid 7z split size')
    this.splitSizeBigInt = BigInt(splitSize)
  }

  get position(): bigint {
    return this.cursor
  }

  private async appendHandle(volumeIndex: number): Promise<fsPromises.FileHandle> {
    if (volumeIndex >= MAX_SEVEN_ZIP_VOLUMES) {
      throw new Libera7zError('LIMIT_EXCEEDED', `7z split archive exceeds ${MAX_SEVEN_ZIP_VOLUMES} volumes`)
    }
    if (this.currentHandle && this.currentVolumeIndex === volumeIndex) return this.currentHandle
    await this.currentHandle?.close()
    const volumePath = sevenZipVolumePath(this.outputPath, volumeIndex + 1)
    this.currentHandle = await fsPromises.open(volumePath, 'w')
    this.currentVolumeIndex = volumeIndex
    this.volumePaths.push(volumePath)
    return this.currentHandle
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    let inputOffset = 0
    while (inputOffset < bytes.length) {
      const volumeIndex = Number(this.cursor / this.splitSizeBigInt)
      const volumeOffset = this.cursor % this.splitSizeBigInt
      const length = Math.min(bytes.length - inputOffset, this.splitSize - Number(volumeOffset))
      const handle = await this.appendHandle(volumeIndex)
      await writeFully(handle, volumeOffset, bytes.subarray(inputOffset, inputOffset + length), signal)
      inputOffset += length
      this.cursor += BigInt(length)
      if (this.cursor % this.splitSizeBigInt === 0n) {
        await this.currentHandle?.close()
        this.currentHandle = null
        this.currentVolumeIndex = -1
      }
    }
  }

  async writeAt(offset: bigint, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (offset < 0n || offset + BigInt(bytes.length) > this.cursor) throw new RangeError('7z patch is outside the volume set')
    let inputOffset = 0
    let archiveOffset = offset
    while (inputOffset < bytes.length) {
      const volumeIndex = Number(archiveOffset / this.splitSizeBigInt)
      const volumeOffset = archiveOffset % this.splitSizeBigInt
      const length = Math.min(bytes.length - inputOffset, this.splitSize - Number(volumeOffset))
      const usesAppendHandle = this.currentHandle !== null && this.currentVolumeIndex === volumeIndex
      const handle = usesAppendHandle
        ? this.currentHandle!
        : await fsPromises.open(this.volumePaths[volumeIndex], 'r+')
      try {
        await writeFully(handle, volumeOffset, bytes.subarray(inputOffset, inputOffset + length), signal)
      } finally {
        if (!usesAppendHandle) await handle.close()
      }
      inputOffset += length
      archiveOffset += BigInt(length)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.currentHandle?.close()
    this.currentHandle = null
  }

  async remove(): Promise<void> {
    await this.close().catch(() => undefined)
    await Promise.all(this.volumePaths.map(volumePath => fsPromises.rm(volumePath, { force: true })))
  }
}

function archivePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

interface CollectedSevenZipEntry extends SevenZipEntryInput {
  /** App-only disk path used to settle per-file compression before writing. */
  sourcePath: string
}

function withoutSourcePath({ sourcePath, ...entry }: CollectedSevenZipEntry): SevenZipEntryInput {
  void sourcePath
  return entry
}

async function collectPathEntries(
  itemPath: string,
  storedPath: string,
  excludedPath: string,
  entries: CollectedSevenZipEntry[],
  compressionForPath?: (
    sourcePath: string,
    size: bigint
  ) => Pick<SevenZipEntryInput, 'method' | 'dictionarySize' | 'lzmaEncoder'>
): Promise<void> {
  if (path.resolve(itemPath) === excludedPath) return
  const stat = await fsPromises.lstat(itemPath)
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(await fsPromises.readlink(itemPath), 'utf8')
    entries.push({
      path: storedPath,
      sourcePath: itemPath,
      size: BigInt(target.length),
      ...compressionForPath?.(itemPath, BigInt(target.length)),
      isSymlink: true,
      modified: stat.mtime,
      mode: stat.mode & 0o7777,
      open: () => Readable.toWeb(Readable.from([target])) as ReadableStream<Uint8Array>
    })
    return
  }
  if (stat.isDirectory()) {
    entries.push({
      path: storedPath,
      sourcePath: itemPath,
      size: 0n,
      isDirectory: true,
      modified: stat.mtime,
      mode: stat.mode & 0o7777
    })
    const children = await fsPromises.readdir(itemPath)
    children.sort((left, right) => left.localeCompare(right))
    for (const child of children) {
      await collectPathEntries(
        path.join(itemPath, child), archivePath(storedPath, child), excludedPath, entries, compressionForPath
      )
    }
    return
  }
  if (!stat.isFile()) {
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Special-file input is not supported: ${itemPath}`)
  }
  entries.push({
    path: storedPath,
    sourcePath: itemPath,
    size: BigInt(stat.size),
    ...compressionForPath?.(itemPath, BigInt(stat.size)),
    modified: stat.mtime,
    mode: stat.mode & 0o7777,
    open: () => Readable.toWeb(fs.createReadStream(itemPath)) as ReadableStream<Uint8Array>
  })
}

export async function collectSevenZipInputs(
  inputPaths: string[],
  outputPath: string,
  compressionForPath?: (
    sourcePath: string,
    size: bigint
  ) => Pick<SevenZipEntryInput, 'method' | 'dictionarySize' | 'lzmaEncoder'>
): Promise<SevenZipEntryInput[]> {
  return (await collectSevenZipInputDetails(inputPaths, outputPath, compressionForPath)).map(withoutSourcePath)
}

async function collectSevenZipInputDetails(
  inputPaths: string[],
  outputPath: string,
  compressionForPath?: (
    sourcePath: string,
    size: bigint
  ) => Pick<SevenZipEntryInput, 'method' | 'dictionarySize' | 'lzmaEncoder'>
): Promise<CollectedSevenZipEntry[]> {
  const entries: CollectedSevenZipEntry[] = []
  const excludedPath = path.resolve(outputPath)
  for (const itemPath of inputPaths) {
    await collectPathEntries(itemPath, path.basename(itemPath), excludedPath, entries, compressionForPath)
  }
  if (entries.length === 0) throw new Libera7zError('UNSUPPORTED_FEATURE', 'No supported 7z inputs remain')
  return entries
}

/** Everything that decides how an entry is written, short of writing it. */
export interface SevenZipPlanOptions {
  inputPaths: string[]
  outputPath: string
  level: number
  dictionarySize?: number
  method?: SevenZipMethod
  methodOverrides?: SevenZipMethodOverride[]
  matchFinderWordSize?: 32 | 64 | 128 | 273
  searchCycles?: number
  solid?: boolean
}

export interface WriteLibera7zOptions extends SevenZipPlanOptions {
  splitSize?: number
  password?: string
  encryptFileNames?: boolean
  signal?: AbortSignal
  onProgress?: CreateSevenZipOptions['onProgress']
}

interface ArchivePlan {
  method: SevenZipMethod
  dictionarySize: number
  compressionForPath: (
    sourcePath: string,
    fileSize: bigint
  ) => PendingEntryCompression
}

type PendingDictionary =
  | { kind: 'automatic'; level: SevenZipCompressionLevel }
  | { kind: 'fixed'; size: number }

interface PendingEntryCompression {
  method: SevenZipMethod
  dictionary?: PendingDictionary
  searchDepth?: number
  niceLength?: number
}

/**
 * The archive-wide method and dictionary, plus the rule that settles each
 * entry's own. Shared so a block preview answers with what a write would do.
 */
function archivePlan(options: SevenZipPlanOptions): ArchivePlan {
  const method: SevenZipMethod = options.method ?? (options.level === 0 ? 'copy' : 'lzma2')
  const defaultCompressedLevel: SevenZipCompressionLevel = options.level === 0
    ? 1
    : (options.level as SevenZipCompressionLevel)
  return {
    method,
    dictionarySize: options.dictionarySize ?? DICTIONARY_BY_LEVEL[defaultCompressedLevel],
    compressionForPath: sourcePath => {
      const resolved = resolveSevenZipMethod(sourcePath, method, options.methodOverrides)
      if (resolved.method === 'copy') return { method: 'copy' }
      const level = resolved.level ?? defaultCompressedLevel
      const levelOptions = ENCODER_BY_LEVEL[level]
      const dictionary: PendingDictionary = resolved.dictionarySize === undefined
        ? options.dictionarySize === undefined
          ? { kind: 'automatic', level }
          : { kind: 'fixed', size: options.dictionarySize }
        : resolved.dictionarySize === 'auto'
          ? { kind: 'automatic', level }
          : { kind: 'fixed', size: resolved.dictionarySize }
      return {
        method: resolved.method,
        dictionary,
        searchDepth: resolved.searchCycles ?? options.searchCycles ?? levelOptions.searchDepth,
        niceLength: resolved.matchFinderWordSize ?? options.matchFinderWordSize ?? levelOptions.niceLength
      }
    }
  }
}

function samePendingDictionary(left: PendingDictionary, right: PendingDictionary): boolean {
  if (left.kind === 'fixed') return right.kind === 'fixed' && left.size === right.size
  return right.kind === 'automatic' && left.level === right.level
}

function canShareSolidBlock(left: PendingEntryCompression, right: PendingEntryCompression): boolean {
  return left.method === 'lzma2' &&
    right.method === 'lzma2' &&
    left.dictionary !== undefined &&
    right.dictionary !== undefined &&
    samePendingDictionary(left.dictionary, right.dictionary) &&
    left.searchDepth === right.searchDepth &&
    left.niceLength === right.niceLength
}

/**
 * Settles automatic dictionaries after solid runs are known. A solid stream
 * needs one shared dictionary, so its total input size - not each file's size -
 * chooses that dictionary. Non-solid entries remain independent as before.
 */
function settleSevenZipEntries(
  entries: CollectedSevenZipEntry[],
  plan: ArchivePlan,
  solid: boolean
): SevenZipEntryInput[] {
  const pending = entries
    .filter(entry => !entry.isDirectory && entry.size > 0n)
    .map(entry => ({ entry, compression: plan.compressionForPath(entry.sourcePath, entry.size) }))

  for (let index = 0; index < pending.length;) {
    const head = pending[index]
    if (head.compression.method === 'copy') {
      head.entry.method = 'copy'
      index += 1
      continue
    }

    let end = index + 1
    if (solid) {
      while (end < pending.length && canShareSolidBlock(head.compression, pending[end].compression)) end += 1
    }
    const run = pending.slice(index, end)
    const dictionary = head.compression.dictionary!
    const dictionarySize = dictionary.kind === 'fixed'
      ? dictionary.size
      : automaticSevenZipDictionarySize(
          run.reduce((total, item) => total + item.entry.size, 0n),
          dictionary.level
        )
    for (const item of run) {
      item.entry.method = 'lzma2'
      item.entry.dictionarySize = dictionarySize
      item.entry.lzmaEncoder = {
        searchDepth: item.compression.searchDepth,
        niceLength: item.compression.niceLength,
        maxDistance: dictionarySize
      }
    }
    index = end
  }
  return entries.map(withoutSourcePath)
}

export interface WriteLibera7zResult {
  outputPath: string
  volumePaths?: string[]
}

const DICTIONARY_BY_LEVEL: Record<number, number> = {
  1: 1024 * 1024,
  3: 4 * 1024 * 1024,
  5: 16 * 1024 * 1024,
  7: 32 * 1024 * 1024,
  9: 64 * 1024 * 1024
}

const ENCODER_BY_LEVEL: Record<number, { searchDepth: number; niceLength: number }> = {
  1: { searchDepth: 8, niceLength: 32 },
  3: { searchDepth: 16, niceLength: 32 },
  5: { searchDepth: 32, niceLength: 32 },
  7: { searchDepth: 64, niceLength: 64 },
  9: { searchDepth: 128, niceLength: 128 }
}

const AUTOMATIC_DICTIONARIES = [
  64 * 1024,
  128 * 1024,
  256 * 1024,
  512 * 1024,
  1024 * 1024,
  2 * 1024 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
  16 * 1024 * 1024,
  32 * 1024 * 1024,
  64 * 1024 * 1024,
  128 * 1024 * 1024
] as const

export function automaticSevenZipDictionarySize(inputSize: bigint, level: SevenZipCompressionLevel): number {
  const cap = DICTIONARY_BY_LEVEL[level]
  const target = inputSize > BigInt(cap) ? cap : Number(inputSize)
  return AUTOMATIC_DICTIONARIES.find(size => size >= target) ?? cap
}

export interface SevenZipSolidBlock {
  method: SevenZipMethod
  /** The dictionary every entry in the block shares. Copy blocks have none. */
  dictionarySize?: number
  entries: { path: string; size: number }[]
  totalBytes: number
}

/**
 * The streams a write would lay down, without writing one. Blocks follow the
 * archive's own entry order rather than any listing the dialog shows, and hold
 * only the entries that carry data - directories and empty files reach none.
 */
export async function planSevenZipSolidBlocks(
  options: SevenZipPlanOptions
): Promise<SevenZipSolidBlock[]> {
  if (options.inputPaths.length === 0) return []
  const plan = archivePlan(options)
  const entries = settleSevenZipEntries(
    await collectSevenZipInputDetails(options.inputPaths, options.outputPath),
    plan,
    options.solid === true
  )
  const plans = planSevenZipEntries(entries, {
    method: plan.method,
    dictionarySize: plan.dictionarySize
  })
  return sevenZipSolidRuns(plans, options.solid === true).map(run => ({
    method: run[0].method,
    ...(run[0].method === 'lzma2' && run[0].lzmaEncoder.maxDistance !== undefined
      ? { dictionarySize: run[0].lzmaEncoder.maxDistance }
      : {}),
    entries: run.map(plan => ({ path: plan.entry.path, size: Number(plan.entry.size) })),
    totalBytes: run.reduce((total, plan) => total + Number(plan.entry.size), 0)
  }))
}

export async function writeLibera7z(options: WriteLibera7zOptions): Promise<WriteLibera7zResult> {
  if (options.splitSize !== undefined) await removeStaleSevenZipVolumes(options.outputPath)
  const plan = archivePlan(options)
  const entries = settleSevenZipEntries(
    await collectSevenZipInputDetails(options.inputPaths, options.outputPath),
    plan,
    options.solid === true
  )
  const sink = options.splitSize === undefined
    ? await NodeFileSink.open(options.outputPath)
    : new NodeVolumeSink(options.outputPath, options.splitSize)
  try {
    await create7z(entries, sink, {
      method: plan.method,
      dictionarySize: plan.dictionarySize,
      signal: options.signal,
      onProgress: options.onProgress,
      password: options.password,
      encryptHeader: options.encryptFileNames,
      solid: options.solid
    })
    if (sink instanceof NodeVolumeSink) {
      return { outputPath: sink.volumePaths[0], volumePaths: [...sink.volumePaths] }
    }
    return { outputPath: options.outputPath }
  } catch (error) {
    await sink.close().catch(() => undefined)
    if (sink instanceof NodeVolumeSink) await sink.remove().catch(() => undefined)
    else await fsPromises.rm(options.outputPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function openLibera7zFile(
  archivePath: string,
  options: OpenSevenZipOptions = {}
): Promise<SevenZipReader> {
  const source = isSevenZipVolumePath(archivePath)
    ? await NodeVolumeSource.open(await discoverSevenZipVolumes(archivePath))
    : await NodeFileSource.open(archivePath)
  try {
    return await open7z(source, options)
  } catch (error) {
    await source.close().catch(() => undefined)
    throw error
  }
}
