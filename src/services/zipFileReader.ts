import { promises as fsPromises } from 'fs'
import type { FileHandle } from 'fs/promises'
import {
  Reader,
  ZipReader,
  configure,
  type Entry,
  type ZipReaderConstructorOptions
} from '@zip.js/zip.js'

configure({ useWebWorkers: false })

export class NodeFileReader extends Reader<string> {
  private handle: FileHandle | null = null

  constructor(private readonly filePath: string) {
    super(filePath)
  }

  async init(): Promise<void> {
    this.handle = await fsPromises.open(this.filePath, 'r')
    this.size = (await this.handle.stat()).size
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (!this.handle) throw new Error('ZIP reader is not initialized')

    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await this.handle.read(buffer, 0, length, index)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    await handle?.close()
  }
}

export interface OpenZipArchive {
  reader: ZipReader<string>
  entries: Entry[]
  close: () => Promise<void>
}

export async function openZipArchive(
  archivePath: string,
  maxEntries: number,
  options: ZipReaderConstructorOptions = {}
): Promise<OpenZipArchive> {
  const fileReader = new NodeFileReader(archivePath)
  const reader = new ZipReader(fileReader, {
    strictness: 'strict',
    checkCrc32: true,
    checkOverlappingEntry: true,
    ...options
  })
  const entries: Entry[] = []

  try {
    for await (const entry of reader.getEntriesGenerator()) {
      entries.push(entry)
      if (entries.length > maxEntries) break
    }
  } catch (error) {
    await reader.close().catch(() => undefined)
    await fileReader.close().catch(() => undefined)
    throw error
  }

  return {
    reader,
    entries,
    close: async () => {
      await reader.close().catch(() => undefined)
      await fileReader.close().catch(() => undefined)
    }
  }
}
