import { promises as fsPromises } from 'fs'
import type { FileHandle } from 'fs/promises'
import {
  Reader,
  ZipReader,
  configure,
  type Entry,
  type ZipReaderConstructorOptions
} from '@zip.js/zip.js'
import {
  discoverSplitVolumes,
  readZipTerminalDiskNumber,
  splitVolumeBase,
  terminalVolumePath,
  volumePathForDisk
} from './volumes'

configure({ useWebWorkers: false })

// APPNOTE's spanning marker, written at the very start of a split set's first
// volume. Its 4 bytes shift every recorded offset, which is why a split set can
// never be read at full strictness.
const SPANNING_SIGNATURE = 0x08074b50
const SPANNING_SIGNATURE_LENGTH = 4

export class NodeFileReader extends Reader<string> {
  // Set by zip.js's Stream.init at runtime; only the type is missing.
  declare initialized?: boolean

  private handle: FileHandle | null = null

  constructor(private readonly filePath: string) {
    super(filePath)
  }

  async init(): Promise<void> {
    // zip.js re-runs init() on any reader that has not flagged itself
    // initialized, which would open a second handle and leak the first.
    if (this.handle) return

    this.handle = await fsPromises.open(this.filePath, 'r')
    this.size = (await this.handle.stat()).size
    this.initialized = true
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
  volumePaths: string[]
  volumeSizes: number[]
  totalBytes: number
  isSplit: boolean
  close: () => Promise<void>
}

async function startsWithSpanningSignature(filePath: string): Promise<boolean> {
  const handle = await fsPromises.open(filePath, 'r').catch(() => null)
  if (!handle) return false

  try {
    const buffer = Buffer.alloc(SPANNING_SIGNATURE_LENGTH)
    const { bytesRead } = await handle.read(buffer, 0, SPANNING_SIGNATURE_LENGTH, 0)
    return bytesRead === SPANNING_SIGNATURE_LENGTH && buffer.readUInt32LE(0) === SPANNING_SIGNATURE
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Decides whether a failed strict open should be retried as a volume set.
 * Probing the files rather than matching zip.js error messages keeps this
 * working across the several errors a split set can raise: a set missing its
 * spanning volume, one whose disk count disagrees, and a single-volume set
 * whose marker merely looks like prepended data.
 */
async function looksLikeSplitArchive(terminalPath: string): Promise<boolean> {
  const firstVolume = volumePathForDisk(splitVolumeBase(terminalPath), 0)
  const hasFirstVolume = await fsPromises
    .lstat(firstVolume)
    .then((stat) => stat.isFile())
    .catch(() => false)

  if (hasFirstVolume) return true
  if (await startsWithSpanningSignature(terminalPath)) return true
  return readZipTerminalDiskNumber(terminalPath).then(diskNumber => (diskNumber ?? 0) > 0, () => false)
}

/**
 * Reproduces the two checks that `strictness: 'balanced'` gives up and that the
 * app can still make from the entry list. The remaining strict-only checks
 * (trailing central directory data, zip64 end-of-directory consistency) have no
 * public equivalent.
 */
function assertSafeSplitLayout(entries: Entry[], volumeSizes: number[]): void {
  const names = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.filename)) {
      throw new Error(`Unsafe archive: duplicate entry name: ${entry.filename}`)
    }
    names.add(entry.filename)
  }

  const diskOffsets: number[] = []
  let total = 0
  for (const size of volumeSizes) {
    diskOffsets.push(total)
    total += size
  }

  let startOffset = total
  for (const entry of entries) {
    const diskOffset = diskOffsets[entry.diskNumberStart]
    if (diskOffset === undefined) {
      throw new Error(`Unsafe archive: entry references a volume outside the set: ${entry.filename}`)
    }
    startOffset = Math.min(startOffset, diskOffset + entry.offset)
  }

  // A well-formed set starts its first local header right after the 4 byte
  // spanning marker; anything earlier in the address space is prepended data.
  if (entries.length > 0 && startOffset > SPANNING_SIGNATURE_LENGTH) {
    throw new Error('Unsafe archive: prepended data')
  }
}

async function openVolumes(
  volumePaths: string[],
  maxEntries: number,
  zipOptions: ZipReaderConstructorOptions
): Promise<OpenZipArchive> {
  const fileReaders = volumePaths.map((volumePath) => new NodeFileReader(volumePath))
  const closeReaders = async () => {
    await Promise.all(fileReaders.map((fileReader) => fileReader.close().catch(() => undefined)))
  }

  try {
    await Promise.all(fileReaders.map((fileReader) => fileReader.init()))
  } catch (error) {
    await closeReaders()
    throw error
  }

  // A lone reader is passed through unchanged so non-split archives behave
  // exactly as before; an array is wrapped in a SplitDataReader by zip.js.
  const source = fileReaders.length === 1 ? fileReaders[0] : fileReaders
  const reader = new ZipReader(source, zipOptions)
  const entries: Entry[] = []

  try {
    for await (const entry of reader.getEntriesGenerator()) {
      entries.push(entry)
      if (entries.length > maxEntries) break
    }
  } catch (error) {
    await reader.close().catch(() => undefined)
    await closeReaders()
    throw error
  }

  const volumeSizes = fileReaders.map((fileReader) => fileReader.size)

  return {
    reader,
    entries,
    volumePaths,
    volumeSizes,
    totalBytes: volumeSizes.reduce((sum, size) => sum + size, 0),
    isSplit: volumePaths.length > 1,
    close: async () => {
      await reader.close().catch(() => undefined)
      await closeReaders()
    }
  }
}

export async function openZipArchive(
  archivePath: string,
  maxEntries: number,
  options: ZipReaderConstructorOptions = {}
): Promise<OpenZipArchive> {
  const terminalPath = terminalVolumePath(archivePath)

  try {
    return await openVolumes([terminalPath], maxEntries, {
      strictness: 'strict',
      checkCrc32: true,
      checkOverlappingEntry: true,
      ...options
    })
  } catch (error) {
    if (!(await looksLikeSplitArchive(terminalPath))) throw error
  }

  const volumePaths = await discoverSplitVolumes(terminalPath)
  // Strictness has to drop for the spanning marker; every check that does not
  // hang off it stays on, and getData() callers keep passing their own strict
  // option, so local header validation survives per entry.
  const archive = await openVolumes(volumePaths, maxEntries, {
    strictness: 'balanced',
    maxAppendedDataSize: 0,
    checkCrc32: true,
    checkOverlappingEntry: true,
    ...options
  })

  try {
    assertSafeSplitLayout(archive.entries, archive.volumeSizes)
  } catch (error) {
    await archive.close()
    throw error
  }

  return { ...archive, isSplit: true }
}
