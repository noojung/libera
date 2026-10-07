import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { MAX_ARCHIVE_ENTRIES, securityError, throwIfAborted } from '../extractionSafety'
import { probeApfs, readApfs } from './apfs'
import { type ByteSource, EntryBudget, SliceSource, type Volume } from './bytes'
import { probeFat, readFat } from './fat'
import { probeHfsPlus, readHfsPlus } from './hfsplus'
import { readPartitionMap } from './partitions'
import { FileSource, UdifImage } from './udif'

export interface DmgEntry {
  path: string
  isDirectory: boolean
  isLink: boolean
  linkTarget?: string
  size: number
  mode?: number
  date?: string
}

export function isDmgArchivePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.dmg')
}

const FILE_TYPES = [0o040000, 0o100000, 0o120000]

/** Finds every filesystem on the disk: in each partition, or across the whole of it. */
async function readVolumes(disk: UdifImage, budget: EntryBudget, signal?: AbortSignal): Promise<Volume[]> {
  const ranges = new Map<number, number>()
  for (const range of [...await readPartitionMap(disk), ...disk.partitions, { offset: 0, length: disk.size }]) {
    if (range.length > 0 && range.offset + range.length <= disk.size && !ranges.has(range.offset)) ranges.set(range.offset, range.length)
  }
  const volumes: Volume[] = []
  for (const [offset, length] of [...ranges].sort((a, b) => a[0] - b[0])) {
    throwIfAborted(signal)
    const source: ByteSource = new SliceSource(disk, offset, length)
    const hfs = await probeHfsPlus(source)
    if (hfs) volumes.push(await readHfsPlus(hfs, budget))
    else if (await probeApfs(source)) volumes.push(...await readApfs(source, budget))
    else if (await probeFat(source)) volumes.push(await readFat(source, budget))
  }
  if (volumes.length === 0) throw new Error('Unsupported DMG filesystem: cannot list the files inside this disk image')
  return volumes
}

/**
 * Lists and reads a disk image in TypeScript: the UDIF container, then the
 * HFS+, APFS or FAT volumes inside it. Each volume's files sit under a folder
 * named after the volume, as they would appear once the image is mounted.
 */
export class DmgReader {
  entries: DmgEntry[] = []
  private readonly contents = new WeakMap<DmgEntry, () => AsyncIterable<Uint8Array>>()
  private closing?: Promise<void>

  private constructor(private readonly handle: FileHandle) {}

  static async open(archivePath: string, maxEntries = MAX_ARCHIVE_ENTRIES, signal?: AbortSignal): Promise<DmgReader> {
    throwIfAborted(signal)
    const reader = new DmgReader(await fs.open(archivePath, 'r'))
    try {
      const stat = await reader.handle.stat()
      if (!stat.isFile()) throw new Error('DMG input must be a file')
      const disk = await UdifImage.open(new FileSource(reader.handle, stat.size))
      const budget = new EntryBudget(maxEntries, () => { throw securityError('DMG contains too many entries', 'TOO_MANY_ENTRIES') })
      const volumes = await readVolumes(disk, budget, signal)
      throwIfAborted(signal)
      reader.addVolumes(volumes, maxEntries)
      return reader
    } catch (error) {
      await reader.close()
      throw error
    }
  }

  private addVolumes(volumes: Volume[], maxEntries: number): void {
    const paths = new Set<string>()
    for (const volume of volumes) {
      // A volume name is free text; it becomes one folder, and two volumes
      // with the same name get distinct ones.
      const base = volume.name.replace(/\//g, ':').replace(/^\.{1,2}$/, '') || 'Untitled'
      let root = base
      for (let n = 2; paths.has(root); n++) root = `${base} (${n})`
      const all = [{ path: '', isDirectory: true, isLink: false, size: 0 }, ...volume.entries]
      for (const item of all) {
        const entryPath = item.path ? `${root}/${item.path}` : root
        if (entryPath.includes('\0') || entryPath.split('/').some(part => part === '') || paths.has(entryPath)) {
          throw securityError('Invalid or duplicate DMG entry path')
        }
        if (item.mode !== undefined && !FILE_TYPES.includes(item.mode & 0o170000)) throw securityError('Unsupported DMG file type')
        paths.add(entryPath)
        if (paths.size > maxEntries) throw securityError('DMG contains too many entries', 'TOO_MANY_ENTRIES')
        const entry: DmgEntry = { path: entryPath, isDirectory: item.isDirectory, isLink: item.isLink, size: item.size }
        if (item.linkTarget !== undefined) entry.linkTarget = item.linkTarget
        if (item.mode !== undefined) entry.mode = item.mode
        if (item.date !== undefined) entry.date = item.date
        if ('content' in item && item.content) this.contents.set(entry, item.content)
        this.entries.push(entry)
      }
    }
  }

  /** Streams an entry's bytes to `onData`, one piece at a time. */
  async read(entry: DmgEntry, maxBytes: number, onData: (bytes: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (entry.isDirectory) throw new Error('Cannot read a DMG directory')
    const content = this.contents.get(entry)
    if (!content) throw new Error('DMG entry was not found')
    if (this.closing) throw new Error('DMG reader is closed')
    throwIfAborted(signal)
    let count = 0
    for await (const bytes of content()) {
      throwIfAborted(signal)
      count += bytes.length
      if (count > maxBytes) throw new Error('DMG output exceeds the configured size limit')
      await onData(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length))
      throwIfAborted(signal)
    }
  }

  close(): Promise<void> {
    this.closing ??= this.handle.close()
    return this.closing
  }
}
