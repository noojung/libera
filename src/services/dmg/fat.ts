import {
  type ByteSource, EntryBudget, type Extent, ExtentSource, invalid, readSource, u16le, u32le, utf16le,
  type Volume, type VolumeEntry
} from './bytes'

// FAT12, FAT16 and FAT32, for the occasional image formatted as an MS-DOS
// disk. A boot sector describes the layout; the allocation table chains each
// file's clusters; directories are arrays of 32-byte entries, with long names
// spread across extra entries in front of the short one they belong to.
// Layout follows Microsoft's FAT specification.

const ATTR_VOLUME_ID = 0x08
const ATTR_DIRECTORY = 0x10
const ATTR_LONG_NAME = 0x0f
const MAX_TABLE_BYTES = 128 * 1024 * 1024
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024

interface Layout {
  bytesPerSector: number
  clusterSize: number
  bits: 12 | 16 | 32
  fatOffset: number
  fatBytes: number
  rootOffset: number
  rootBytes: number
  rootCluster: number
  dataOffset: number
  clusterCount: number
  label: string
}

function layoutOf(boot: Uint8Array): Layout | undefined {
  if (boot[510] !== 0x55 || boot[511] !== 0xaa || (boot[0] !== 0xeb && boot[0] !== 0xe9)) return undefined
  const bytesPerSector = u16le(boot, 11)
  const sectorsPerCluster = boot[13]
  const reserved = u16le(boot, 14)
  const fatCount = boot[16]
  const rootEntries = u16le(boot, 17)
  const totalSectors = u16le(boot, 19) || u32le(boot, 32)
  const fatSectors = u16le(boot, 22) || u32le(boot, 36)
  if (![512, 1024, 2048, 4096].includes(bytesPerSector) || sectorsPerCluster === 0 ||
      (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0 || reserved === 0 || fatCount === 0 ||
      totalSectors === 0 || fatSectors === 0) {
    return undefined
  }
  const rootSectors = Math.ceil(rootEntries * 32 / bytesPerSector)
  const dataSector = reserved + fatCount * fatSectors + rootSectors
  if (dataSector >= totalSectors) return undefined
  const clusterCount = Math.floor((totalSectors - dataSector) / sectorsPerCluster)
  const bits = clusterCount < 4085 ? 12 : clusterCount < 65525 ? 16 : 32
  // FAT32 keeps its root directory in clusters; the others give it a fixed region.
  if ((bits === 32) !== (rootEntries === 0)) return undefined
  const labelAt = bits === 32 ? 71 : 43
  const label = boot[labelAt - 5] === 0x29 ? String.fromCharCode(...boot.subarray(labelAt, labelAt + 11)).trim() : ''
  return {
    bytesPerSector, clusterSize: sectorsPerCluster * bytesPerSector, bits,
    fatOffset: reserved * bytesPerSector, fatBytes: fatSectors * bytesPerSector,
    rootOffset: (reserved + fatCount * fatSectors) * bytesPerSector, rootBytes: rootSectors * bytesPerSector,
    rootCluster: bits === 32 ? u32le(boot, 44) : 0,
    dataOffset: dataSector * bytesPerSector, clusterCount,
    label: label === 'NO NAME' ? '' : label
  }
}

export async function probeFat(source: ByteSource): Promise<boolean> {
  if (source.size < 512) return false
  return layoutOf(await source.read(0, 512)) !== undefined
}

function shortName(entry: Uint8Array): string {
  const text = (from: number, to: number, lower: boolean) => {
    let value = ''
    for (let i = from; i < to; i++) value += String.fromCharCode(i === 0 && entry[0] === 0x05 ? 0xe5 : entry[i])
    value = value.trimEnd()
    return lower ? value.toLowerCase() : value
  }
  const base = text(0, 8, (entry[12] & 0x08) !== 0)
  const extension = text(8, 11, (entry[12] & 0x10) !== 0)
  return extension ? `${base}.${extension}` : base
}

function shortNameChecksum(entry: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) + (sum >> 1) + entry[i]) & 0xff
  return sum
}

function fatDate(date: number, time: number): string | undefined {
  if (date === 0) return undefined
  const value = new Date(1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}

interface DirectoryItem {
  name: string
  isDirectory: boolean
  cluster: number
  size: number
  date?: string
}

class FatVolume {
  private constructor(private readonly source: ByteSource, readonly layout: Layout, private readonly table: Uint8Array) {}

  static async open(source: ByteSource): Promise<FatVolume> {
    const layout = layoutOf(await source.read(0, 512))
    if (!layout) invalid('malformed FAT boot sector')
    // Only clusters that fit in the partition can hold data, whatever the boot
    // sector claims, so only their part of the table is read.
    layout.clusterCount = Math.min(layout.clusterCount, Math.max(0, Math.floor((source.size - layout.dataOffset) / layout.clusterSize)))
    const tableBytes = Math.min(layout.fatBytes, Math.ceil((layout.clusterCount + 2) * layout.bits / 8))
    if (tableBytes > MAX_TABLE_BYTES) invalid('FAT allocation table is too large')
    return new FatVolume(source, layout, await source.read(layout.fatOffset, tableBytes))
  }

  private next(cluster: number): number {
    const table = this.table
    if (this.layout.bits === 32) return u32le(table, cluster * 4) & 0x0fffffff
    if (this.layout.bits === 16) return u16le(table, cluster * 2)
    const word = u16le(table, Math.floor(cluster * 3 / 2))
    return cluster & 1 ? word >> 4 : word & 0xfff
  }

  /** A cluster chain as extents, joining clusters that sit next to each other. */
  chain(first: number, size?: number): ByteSource {
    const end = this.layout.bits === 32 ? 0x0ffffff8 : this.layout.bits === 16 ? 0xfff8 : 0xff8
    const extents: Extent[] = []
    const needed = size === undefined ? Infinity : Math.ceil(size / this.layout.clusterSize)
    let logical = 0
    let count = 0
    for (let cluster = first; size === undefined ? cluster < end : count < needed; cluster = this.next(cluster), count++) {
      if (cluster < 2 || cluster >= this.layout.clusterCount + 2) invalid('FAT cluster chain is broken')
      if (count > this.layout.clusterCount) invalid('FAT cluster chain loops')
      const physical = this.layout.dataOffset + (cluster - 2) * this.layout.clusterSize
      const last = extents[extents.length - 1]
      if (last && last.physical! + last.length === physical) last.length += this.layout.clusterSize
      else extents.push({ logical, physical, length: this.layout.clusterSize })
      logical += this.layout.clusterSize
    }
    if (size === undefined && logical > MAX_DIRECTORY_BYTES) invalid('FAT directory is too large')
    return new ExtentSource(this.source, extents, size ?? logical)
  }

  async directory(cluster: number | undefined, isRoot: boolean): Promise<{ items: DirectoryItem[]; label?: string }> {
    const bytes = cluster === undefined
      ? await this.source.read(this.layout.rootOffset, this.layout.rootBytes)
      : await (async () => { const chain = this.chain(cluster); return chain.read(0, chain.size) })()
    const items: DirectoryItem[] = []
    let label: string | undefined
    let longName: string[] = []
    let longChecksum = -1
    for (let at = 0; at + 32 <= bytes.length; at += 32) {
      const entry = bytes.subarray(at, at + 32)
      if (entry[0] === 0x00) break
      if (entry[0] === 0xe5) { longName = []; continue }
      const attributes = entry[11]
      if ((attributes & 0x3f) === ATTR_LONG_NAME) {
        const order = entry[0] & 0x1f
        if (entry[0] & 0x40) { longName = []; longChecksum = entry[13] }
        // Pieces come last first: 5, 6 and 2 UTF-16 units from three spans.
        longName[order - 1] = utf16le(entry, 1, 5) + utf16le(entry, 14, 6) + utf16le(entry, 28, 2)
        continue
      }
      if (attributes & ATTR_VOLUME_ID) {
        if (isRoot) label = String.fromCharCode(...entry.subarray(0, 11)).trim()
        longName = []
        continue
      }
      let name = shortName(entry)
      if (longName.length > 0 && longChecksum === shortNameChecksum(entry) && Array.from(longName).every(part => part !== undefined)) {
        const joined = longName.join('')
        const stop = joined.indexOf('\0')
        name = stop < 0 ? joined : joined.slice(0, stop)
      }
      longName = []
      if (name === '.' || name === '..') continue
      items.push({
        name, isDirectory: (attributes & ATTR_DIRECTORY) !== 0,
        cluster: (this.layout.bits === 32 ? u16le(entry, 20) * 0x10000 : 0) + u16le(entry, 26),
        size: u32le(entry, 28), date: fatDate(u16le(entry, 24), u16le(entry, 22))
      })
    }
    return { items, label }
  }
}

/** Lists a FAT volume, named after its label. */
export async function readFat(source: ByteSource, budget: EntryBudget): Promise<Volume> {
  const volume = await FatVolume.open(source)
  const root = await volume.directory(volume.layout.bits === 32 ? volume.layout.rootCluster : undefined, true)
  const entries: VolumeEntry[] = []
  const visited = new Set<number>()
  const sorted = (items: DirectoryItem[]) => items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const stack = [{ items: sorted(root.items), index: 0, prefix: '' }]
  while (stack.length > 0) {
    const level = stack[stack.length - 1]
    if (level.index >= level.items.length) {
      stack.pop()
      continue
    }
    const item = level.items[level.index++]
    const path = level.prefix ? `${level.prefix}/${item.name}` : item.name
    budget.take()
    if (item.isDirectory) {
      entries.push({ path, isDirectory: true, isLink: false, size: 0, date: item.date })
      if (item.cluster === 0) continue
      if (visited.has(item.cluster)) invalid('FAT directories form a loop')
      visited.add(item.cluster)
      stack.push({ items: sorted((await volume.directory(item.cluster, false)).items), index: 0, prefix: path })
      continue
    }
    const data = item.size === 0 ? undefined : volume.chain(item.cluster, item.size)
    entries.push({ path, isDirectory: false, isLink: false, size: item.size, date: item.date,
      content: data ? () => readSource(data) : async function* () {} })
  }
  return { name: root.label || volume.layout.label || 'Untitled', entries }
}
