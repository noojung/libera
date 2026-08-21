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
  type SevenZipEntryInput
} from '../lib/libera7z'
import { Libera7zWorkerCodec, Libera7zWorkerDecoder } from './libera7zWorkerCodec'

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

  private async writeFully(offset: bigint, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('7z output offset exceeds Node.js safe range')
    let written = 0
    while (written < bytes.length) {
      if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
      const result = await this.handle.write(bytes, written, bytes.length - written, Number(offset) + written)
      if (result.bytesWritten === 0) throw new Error('Unable to make progress writing the 7z archive')
      written += result.bytesWritten
    }
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.writeFully(this.cursor, bytes, signal)
    this.cursor += BigInt(bytes.length)
  }

  async writeAt(offset: bigint, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (offset < 0n || offset + BigInt(bytes.length) > this.cursor) throw new RangeError('7z patch is outside the file')
    await this.writeFully(offset, bytes, signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close()
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
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Symbolic-link input requires the compatibility backend: ${itemPath}`)
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
    throw new Libera7zError('UNSUPPORTED_FEATURE', `Special-file input requires the compatibility backend: ${itemPath}`)
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
  signal?: AbortSignal
  onProgress?: CreateSevenZipOptions['onProgress']
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

export async function writeLibera7z(options: WriteLibera7zOptions): Promise<void> {
  const entries = await collectSevenZipInputs(options.inputPaths, options.outputPath)
  const sink = await NodeFileSink.open(options.outputPath)
  let workerCodec: Libera7zWorkerCodec | null = null
  try {
    const encoderOptions = ENCODER_BY_LEVEL[options.level] ?? ENCODER_BY_LEVEL[5]
    workerCodec = options.level === 0 ? null : await Libera7zWorkerCodec.create(encoderOptions)
    await create7z(entries, sink, {
      method: options.level === 0 ? 'copy' : 'lzma2',
      dictionarySize: DICTIONARY_BY_LEVEL[options.level] ?? DICTIONARY_BY_LEVEL[5],
      signal: options.signal,
      onProgress: options.onProgress,
      encodeLzma2Chunk: workerCodec?.encode,
      lzmaEncoder: encoderOptions
    })
  } catch (error) {
    await sink.close().catch(() => undefined)
    await fsPromises.rm(options.outputPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await workerCodec?.close().catch(() => undefined)
  }
}

export async function openLibera7zFile(
  archivePath: string,
  options: OpenSevenZipOptions = {}
): Promise<SevenZipArchive> {
  const source = await NodeFileSource.open(archivePath)
  try {
    return await open7z(source, {
      ...options,
      lzma2DecoderFactory: options.lzma2DecoderFactory ?? ((property, signal) =>
        Libera7zWorkerDecoder.create(property, signal)),
      decodeLzma2Buffer: options.decodeLzma2Buffer ?? ((input, property, size, signal) =>
        Libera7zWorkerDecoder.decodeAll(input, property, size, signal))
    })
  } catch (error) {
    await source.close().catch(() => undefined)
    throw error
  }
}

export function canFallbackFromLibera7z(error: unknown): boolean {
  return error instanceof Libera7zError && (
    error.code === 'UNSUPPORTED_FEATURE' ||
    error.code === 'UNSUPPORTED_METHOD'
  )
}
