import {
  type ByteSource, EntryBudget, type Extent, ExtentSource, invalid, readSource, SliceSource,
  u16be, u32be, u64be, u8, unsupported, utf16be, type Volume, type VolumeEntry
} from './bytes'
import { DECMPFS_ATTRIBUTE, decmpfsSize, decmpfsUsesResourceFork, readDecmpfs, UF_COMPRESSED } from './decmpfs'

// HFS+ (and its case-sensitive variant HFSX), the filesystem of most
// installer images. Everything is found through B-trees stored in special
// files: the catalog holds every file and folder, keyed by parent ID and name;
// the extents overflow file holds the fragments of files cut into more than
// eight pieces; the attributes file holds extended attributes. Only the leaf
// records are needed, and the leaves are chained, so no index node is read.
// Layout follows Apple's TN1150.

const HEADER = 1024
const ROOT_PARENT = 1
const ROOT_FOLDER = 2
const EXTENTS_FILE = 3
const CATALOG_FILE = 4
const ATTRIBUTES_FILE = 8
const FOLDER_RECORD = 1
const FILE_RECORD = 2
const DATA_FORK = 0
const RESOURCE_FORK = 0xff
const HFS_EPOCH_OFFSET = 2082844800
const MAX_ATTRIBUTE_BYTES = 64 * 1024 * 1024
const S_IFMT = 0o170000

// Where hard links keep their files, and other bookkeeping no listing shows.
const PRIVATE_DATA = '\0\0\0\0HFS+ Private Data'
const HIDDEN_ROOT_NAMES = new Set([PRIVATE_DATA, '.HFS+ Private Directory Data\r', '.journal', '.journal_info_block'])

const fourCC = (text: string) => (text.charCodeAt(0) << 24 | text.charCodeAt(1) << 16 | text.charCodeAt(2) << 8 | text.charCodeAt(3)) >>> 0
const HARD_LINK_TYPE = fourCC('hlnk')
const HARD_LINK_CREATOR = fourCC('hfs+')
const FOLDER_LINK_TYPE = fourCC('fdrp')
const FOLDER_LINK_CREATOR = fourCC('MACS')

interface ForkData {
  logicalSize: number
  totalBlocks: number
  extents: [number, number][]
}

interface CatalogFolder {
  id: number
  parent: number
  name: string
  mode: number
  date: number
}

interface CatalogFile extends CatalogFolder {
  ownerFlags: number
  special: number
  type: number
  creator: number
  data: ForkData
  resource: ForkData
}

function forkData(bytes: Uint8Array, offset: number): ForkData {
  const extents: [number, number][] = []
  for (let i = 0; i < 8; i++) {
    const count = u32be(bytes, offset + 20 + i * 8)
    if (count > 0) extents.push([u32be(bytes, offset + 16 + i * 8), count])
  }
  return { logicalSize: u64be(bytes, offset), totalBlocks: u32be(bytes, offset + 12), extents }
}

/** Finds an HFS+ volume at the start of `source`, unwrapping a classic HFS wrapper. */
export async function probeHfsPlus(source: ByteSource): Promise<ByteSource | undefined> {
  if (source.size < HEADER + 512) return undefined
  const header = await source.read(HEADER, 512)
  const signature = u16be(header, 0)
  if (signature === 0x482b || signature === 0x4858) return source
  // An HFS volume ('BD') can carry an HFS+ volume embedded in it.
  if (signature === 0x4244 && u16be(header, 0x7c) === 0x482b) {
    const blockSize = u32be(header, 0x14)
    const start = u16be(header, 0x1c) * 512 + u16be(header, 0x7e) * blockSize
    const length = u16be(header, 0x80) * blockSize
    if (blockSize === 0 || blockSize % 512 !== 0 || start + length > source.size) return undefined
    return probeHfsPlus(new SliceSource(source, start, length))
  }
  return undefined
}

class HfsPlusVolume {
  private overflow?: Map<string, [number, number][]>

  constructor(private readonly source: ByteSource, private readonly blockSize: number, private readonly header: Uint8Array) {}

  /** A fork's bytes; `owner` names the file whose overflow extents complete it. */
  async fork(fork: ForkData, owner?: { id: number; forkType: number }): Promise<ByteSource> {
    let blocks = fork.extents
    let counted = blocks.reduce((sum, [, count]) => sum + count, 0)
    // A file in more than eight pieces keeps the rest in the extents overflow file.
    if (counted < fork.totalBlocks && owner && owner.id !== EXTENTS_FILE) {
      const overflow = (await this.overflowExtents()).get(`${owner.id}:${owner.forkType}`) ?? []
      blocks = [...blocks, ...overflow]
      counted = blocks.reduce((sum, [, count]) => sum + count, 0)
    }
    if (counted * this.blockSize < fork.logicalSize) invalid('file is larger than its extents')
    const extents: Extent[] = []
    let logical = 0
    for (const [start, count] of blocks) {
      extents.push({ logical, physical: start * this.blockSize, length: count * this.blockSize })
      logical += count * this.blockSize
    }
    return new ExtentSource(this.source, extents, fork.logicalSize)
  }

  private async overflowExtents(): Promise<Map<string, [number, number][]>> {
    if (this.overflow) return this.overflow
    const overflow = new Map<string, { start: number; extents: [number, number][] }[]>()
    const file = await this.fork(forkData(this.header, 192))
    if (file.size > 0) {
      for await (const record of leafRecords(file)) {
        const keyLength = u16be(record, 0)
        if (keyLength < 10) invalid('malformed extents overflow record')
        const key = `${u32be(record, 4)}:${u8(record, 2)}`
        const extents: [number, number][] = []
        for (let i = 0; i < 8; i++) {
          const count = u32be(record, 2 + keyLength + 4 + i * 8)
          if (count > 0) extents.push([u32be(record, 2 + keyLength + i * 8), count])
        }
        const list = overflow.get(key) ?? []
        list.push({ start: u32be(record, 8), extents })
        overflow.set(key, list)
      }
    }
    this.overflow = new Map([...overflow].map(([key, list]) => [key, list.sort((a, b) => a.start - b.start).flatMap(item => item.extents)]))
    return this.overflow
  }
}

/** Yields every leaf record of a B-tree file, following the chain of leaf nodes. */
async function* leafRecords(file: ByteSource): AsyncGenerator<Uint8Array> {
  const head = await file.read(0, Math.min(512, file.size))
  const nodeSize = u16be(head, 32)
  const totalNodes = u32be(head, 36)
  if (nodeSize < 512 || nodeSize > 32768 || (nodeSize & (nodeSize - 1)) !== 0) invalid('malformed B-tree header')
  let node = u32be(head, 24)
  for (let visited = 0; node !== 0; visited++) {
    if (visited >= totalNodes || node >= totalNodes) invalid('B-tree leaf chain is broken')
    const bytes = await file.read(node * nodeSize, nodeSize)
    if (u8(bytes, 8) !== 0xff) invalid('B-tree leaf chain reaches a non-leaf node')
    const count = u16be(bytes, 10)
    const tableStart = nodeSize - 2 * (count + 1)
    if (tableStart < 14) invalid('malformed B-tree node')
    for (let i = 0; i < count; i++) {
      const start = u16be(bytes, nodeSize - 2 - i * 2)
      const end = u16be(bytes, nodeSize - 4 - i * 2)
      if (start < 14 || end < start || end > tableStart) invalid('malformed B-tree record')
      yield bytes.subarray(start, end)
    }
    node = u32be(bytes, 0)
  }
}

/** Files from before BSD permissions carry no mode; others may lack only the type bits. */
function withType(mode: number, fallback: number): number {
  if (mode === 0) return fallback
  return mode & S_IFMT ? mode : mode | (fallback & S_IFMT)
}

function hfsDate(seconds: number): string | undefined {
  return seconds === 0 ? undefined : new Date((seconds - HFS_EPOCH_OFFSET) * 1000).toISOString()
}

/** Lists an HFS+ volume. Paths start inside the volume; its name comes separately. */
export async function readHfsPlus(source: ByteSource, budget: EntryBudget): Promise<Volume> {
  const header = await source.read(HEADER, 512)
  const blockSize = u32be(header, 40)
  if (blockSize < 512 || (blockSize & (blockSize - 1)) !== 0) invalid('malformed HFS+ volume header')
  const volume = new HfsPlusVolume(source, blockSize, header)
  const catalog = await volume.fork(forkData(header, 272), { id: CATALOG_FILE, forkType: DATA_FORK })

  const folders = new Map<number, CatalogFolder>()
  const files: CatalogFile[] = []
  for await (const record of leafRecords(catalog)) {
    const keyLength = u16be(record, 0)
    const data = 2 + keyLength
    const type = u16be(record, data)
    if (type !== FOLDER_RECORD && type !== FILE_RECORD) continue
    const nameLength = u16be(record, 6)
    if (8 + nameLength * 2 > data) invalid('malformed catalog key')
    // HFS+ stores what POSIX shows as ':' as '/', the one character a path cannot hold.
    const name = utf16be(record, 8, nameLength).replace(/\//g, ':')
    const base = {
      id: u32be(record, data + 8), parent: u32be(record, 2), name,
      mode: u16be(record, data + 42), date: u32be(record, data + 16)
    }
    if (type === FOLDER_RECORD) {
      if (folders.has(base.id)) invalid('duplicate catalog folder')
      folders.set(base.id, base)
    } else {
      files.push({
        ...base, ownerFlags: u8(record, data + 41), special: u32be(record, data + 44),
        type: u32be(record, data + 48), creator: u32be(record, data + 52),
        data: forkData(record, data + 88), resource: forkData(record, data + 168)
      })
    }
  }

  const root = folders.get(ROOT_FOLDER)
  if (!root || root.parent !== ROOT_PARENT) invalid('HFS+ volume has no root folder')
  const privateData = [...folders.values()].find(folder => folder.parent === ROOT_FOLDER && folder.name === PRIVATE_DATA)
  const inodes = new Map<string, CatalogFile>()
  if (privateData) for (const file of files) if (file.parent === privateData.id) inodes.set(file.name, file)

  const children = new Map<number, (CatalogFolder | CatalogFile)[]>()
  for (const item of [...folders.values(), ...files]) {
    const list = children.get(item.parent) ?? []
    list.push(item)
    children.set(item.parent, list)
  }
  const sortedChildren = (id: number) => (children.get(id) ?? []).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  const attributes = files.some(file => file.ownerFlags & UF_COMPRESSED)
    ? await readAttributes(volume, header, DECMPFS_ATTRIBUTE)
    : new Map<number, Uint8Array>()

  // Walked down from the root, parents first, so an orphan or a loop never gets a path.
  const entries: VolumeEntry[] = []
  const visited = new Set<number>([ROOT_FOLDER])
  const stack = [{ items: sortedChildren(ROOT_FOLDER), index: 0, prefix: '' }]
  while (stack.length > 0) {
    const level = stack[stack.length - 1]
    if (level.index >= level.items.length) {
      stack.pop()
      continue
    }
    const item = level.items[level.index++]
    if (stack.length === 1 && HIDDEN_ROOT_NAMES.has(item.name)) continue
    const path = level.prefix ? `${level.prefix}/${item.name}` : item.name
    budget.take()
    if (!('data' in item)) {
      if (visited.has(item.id)) invalid('catalog folders form a loop')
      visited.add(item.id)
      entries.push({ path, isDirectory: true, isLink: false, size: 0, mode: withType(item.mode, 0o040755), date: hfsDate(item.date) })
      stack.push({ items: sortedChildren(item.id), index: 0, prefix: path })
      continue
    }
    let file = item
    if (file.type === FOLDER_LINK_TYPE && file.creator === FOLDER_LINK_CREATOR) unsupported('directory hard links')
    if (file.type === HARD_LINK_TYPE && file.creator === HARD_LINK_CREATOR) {
      const inode = inodes.get(`iNode${file.special}`)
      if (!inode) invalid('hard link points at a missing file')
      file = inode
    }
    entries.push(await fileEntry(volume, file, path, attributes))
  }
  return { name: root.name, entries }
}

async function fileEntry(volume: HfsPlusVolume, file: CatalogFile, path: string, attributes: Map<number, Uint8Array>): Promise<VolumeEntry> {
  const mode = withType(file.mode, 0o100644)
  const isLink = (mode & S_IFMT) === 0o120000
  const date = hfsDate(file.date)
  const compression = file.ownerFlags & UF_COMPRESSED ? attributes.get(file.id) : undefined
  if (compression && !isLink) {
    const resource = decmpfsUsesResourceFork(compression) ? await volume.fork(file.resource, { id: file.id, forkType: RESOURCE_FORK }) : undefined
    return { path, isDirectory: false, isLink, mode, date, size: decmpfsSize(compression), content: () => readDecmpfs(compression, resource) }
  }
  const data = await volume.fork(file.data, { id: file.id, forkType: DATA_FORK })
  return { path, isDirectory: false, isLink, mode, date, size: data.size, content: () => readSource(data) }
}

/** Collects one attribute, by name, for every file that has it. */
async function readAttributes(volume: HfsPlusVolume, header: Uint8Array, wanted: string): Promise<Map<number, Uint8Array>> {
  const found = new Map<number, Uint8Array>()
  const fork = forkData(header, 352)
  if (fork.logicalSize === 0) return found
  const file = await volume.fork(fork, { id: ATTRIBUTES_FILE, forkType: DATA_FORK })
  for await (const record of leafRecords(file)) {
    const keyLength = u16be(record, 0)
    const nameLength = u16be(record, 12)
    if (14 + nameLength * 2 > 2 + keyLength) invalid('malformed attribute key')
    if (u32be(record, 8) !== 0 || utf16be(record, 14, nameLength) !== wanted) continue
    const data = 2 + keyLength
    const type = u32be(record, data)
    if (type === 0x10) {
      const size = u32be(record, data + 12)
      if (data + 16 + size > record.length) invalid('malformed attribute record')
      found.set(u32be(record, 4), record.slice(data + 16, data + 16 + size))
    } else if (type === 0x20) {
      // Attribute forks continue in the attributes file itself, which no
      // compressed file needs: its header is small enough to sit in one piece.
      const source = await volume.fork(forkData(record, data + 8))
      if (source.size > MAX_ATTRIBUTE_BYTES) invalid('attribute is too large')
      found.set(u32be(record, 4), await source.read(0, source.size))
    }
  }
  return found
}
