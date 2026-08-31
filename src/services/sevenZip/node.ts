import fs, { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import path from 'path'
import {
  SevenZipArchive,
  Libera7zError,
  create7z,
  open7z,
  type CreateSevenZipOptions,
  type OpenSevenZipOptions,
  type RandomAccessSource,
  type SeekableSink,
  type SevenZipEntryInput,
  type SevenZipMethod,
  type SevenZipReader
} from 'libera7z'
import { openLibera7zFileInWorker } from './readWorkerClient'
import { runLibera7zWriteInWorker } from './writeWorkerClient'
import {
  discoverSevenZipVolumes,
  isSevenZipVolumePath,
  MAX_SEVEN_ZIP_VOLUMES,
  removeStaleSevenZipVolumes,
  sevenZipVolumePath
} from './volumes'

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

async function collectPathEntries(
  itemPath: string,
  storedPath: string,
  excludedPath: string,
  entries: SevenZipEntryInput[]
): Promise<void> {
  if (path.resolve(itemPath) === excludedPath) return
  const stat = await fsPromises.lstat(itemPath)
  if (stat.isSymbolicLink()) {
    const target = Buffer.from(await fsPromises.readlink(itemPath), 'utf8')
    entries.push({
      path: storedPath,
      size: BigInt(target.length),
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
      size: 0n,
      isDirectory: true,
      modified: stat.mtime,
      mode: stat.mode & 0o7777
    })
    const children = await fsPromises.readdir(itemPath)
    children.sort((left, right) => left.localeCompare(right))
    for (const child of children) {
      await collectPathEntries(path.join(itemPath, child), archivePath(storedPath, child), excludedPath, entries)
    }
    return
  }
  if (!stat.isFile()) {
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Special-file input is not supported: ${itemPath}`)
  }
  entries.push({
    path: storedPath,
    size: BigInt(stat.size),
    modified: stat.mtime,
    mode: stat.mode & 0o7777,
    open: () => Readable.toWeb(fs.createReadStream(itemPath)) as ReadableStream<Uint8Array>
  })
}

export async function collectSevenZipInputs(inputPaths: string[], outputPath: string): Promise<SevenZipEntryInput[]> {
  const entries: SevenZipEntryInput[] = []
  const excludedPath = path.resolve(outputPath)
  for (const itemPath of inputPaths) {
    await collectPathEntries(itemPath, path.basename(itemPath), excludedPath, entries)
  }
  if (entries.length === 0) throw new Libera7zError('UNSUPPORTED_FEATURE', 'No supported 7z inputs remain')
  return entries
}

export interface WriteLibera7zOptions {
  inputPaths: string[]
  outputPath: string
  level: number
  splitSize?: number
  password?: string
  encryptFileNames?: boolean
  dictionarySize?: number
  method?: SevenZipMethod
  matchFinderWordSize?: 32 | 64 | 128 | 273
  searchCycles?: number
  solid?: boolean
  signal?: AbortSignal
  onProgress?: CreateSevenZipOptions['onProgress']
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

export async function writeLibera7z(options: WriteLibera7zOptions): Promise<WriteLibera7zResult> {
  const written = await runLibera7zWriteInWorker(options)
  return written ?? await writeLibera7zInline(options)
}

/** The write itself. Runs on whichever thread called it, worker or main. */
export async function writeLibera7zInline(options: WriteLibera7zOptions): Promise<WriteLibera7zResult> {
  if (options.splitSize !== undefined) await removeStaleSevenZipVolumes(options.outputPath)
  const entries = await collectSevenZipInputs(options.inputPaths, options.outputPath)
  const sink = options.splitSize === undefined
    ? await NodeFileSink.open(options.outputPath)
    : new NodeVolumeSink(options.outputPath, options.splitSize)
  try {
    const levelOptions = ENCODER_BY_LEVEL[options.level] ?? ENCODER_BY_LEVEL[5]
    const encoderOptions = {
      searchDepth: options.searchCycles ?? levelOptions.searchDepth,
      niceLength: options.matchFinderWordSize ?? levelOptions.niceLength
    }
    await create7z(entries, sink, {
      method: options.method ?? (options.level === 0 ? 'copy' : 'lzma2'),
      dictionarySize: options.dictionarySize ?? (DICTIONARY_BY_LEVEL[options.level] ?? DICTIONARY_BY_LEVEL[5]),
      signal: options.signal,
      onProgress: options.onProgress,
      lzmaEncoder: encoderOptions,
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
  const opened = await openLibera7zFileInWorker(archivePath, {
    maxEntries: options.maxEntries,
    password: options.password,
    signal: options.signal
  })
  return opened ?? await openLibera7zFileInline(archivePath, options)
}

/** The reader itself. Runs on whichever thread called it, worker or main. */
export async function openLibera7zFileInline(
  archivePath: string,
  options: OpenSevenZipOptions = {}
): Promise<SevenZipArchive> {
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
