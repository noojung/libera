import {
  type ByteSource, EntryBudget, type Extent, ExtentSource, invalid, readSource, u16le, u32le, u64le,
  u64leBig, unsupported, type Volume, type VolumeEntry
} from './bytes'
import { DECMPFS_ATTRIBUTE, decmpfsSize, decmpfsUsesResourceFork, readDecmpfs, RESOURCE_FORK_ATTRIBUTE, UF_COMPRESSED } from './decmpfs'

// APFS, the filesystem of images made on current macOS. A container holds
// volumes; every structure is an object in a block that carries a Fletcher-64
// checksum. Volumes are found through the container's object map, which turns
// virtual object IDs into block addresses, and each volume keeps one more
// object map for its own filesystem tree. That tree holds every inode,
// directory entry, extended attribute and file extent, all keyed by object ID,
// so one pass over its leaves gathers the whole volume.
// Layout follows Apple's "Apple File System Reference".

const NX_MAGIC = 0x4253584e
const APFS_MAGIC = 0x42535041
const MIN_BLOCK = 4096
const MAX_BLOCK = 65536

const TYPE_MASK = 0xffff
const STORAGE_MASK = 0xc0000000
const OBJ_PHYSICAL = 0x40000000
const OBJECT_TYPE_NX_SUPERBLOCK = 0x01
const OBJECT_TYPE_BTREE = 0x02
const OBJECT_TYPE_BTREE_NODE = 0x03
const OBJECT_TYPE_OMAP = 0x0b
const OBJECT_TYPE_FS = 0x0d

const BTNODE_ROOT = 0x1
const BTNODE_FIXED_KV_SIZE = 0x4
const BTREE_INFO_SIZE = 40
const MAX_TREE_DEPTH = 16

const OMAP_VAL_DELETED = 0x1
const OMAP_VAL_ENCRYPTED = 0x4

const APFS_FS_UNENCRYPTED = 0x1
const INCOMPAT_CASE_INSENSITIVE = 0x1
const INCOMPAT_NORMALIZATION_INSENSITIVE = 0x8
const INCOMPAT_SEALED_VOLUME = 0x20

const TYPE_INODE = 3
const TYPE_XATTR = 4
const TYPE_FILE_EXTENT = 8
const TYPE_DIR_REC = 9

const ROOT_DIR_INO = 2
const XATTR_DATA_STREAM = 0x1
const XATTR_DATA_EMBEDDED = 0x2
const INO_EXT_TYPE_DSTREAM = 8
const SYMLINK_ATTRIBUTE = 'com.apple.fs.symlink'
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const MAX_ATTRIBUTE_BYTES = 64 * 1024 * 1024

const utf8 = new TextDecoder('utf-8')

function fletcher64(block: Uint8Array): boolean {
  const mod = 0xffffffff
  let sum1 = 0
  let sum2 = 0
  for (let i = 8; i < block.length; i += 4) {
    sum1 = (sum1 + ((block[i] | block[i + 1] << 8 | block[i + 2] << 16 | block[i + 3] << 24) >>> 0)) % mod
    sum2 = (sum2 + sum1) % mod
  }
  const check1 = mod - (sum1 + sum2) % mod
  const check2 = mod - (sum1 + check1) % mod
  return u32le(block, 0) === check1 && u32le(block, 4) === check2
}

function objectType(block: Uint8Array): number {
  return u32le(block, 24) & TYPE_MASK
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

/** An object ID's low 60 bits, and the record type in the top four. */
function splitKey(key: Uint8Array): [number, number] {
  const high = u32le(key, 4)
  return [(high & 0x0fffffff) * 0x100000000 + u32le(key, 0), high >>> 28]
}

function nanosecondsToIso(ns: bigint): string | undefined {
  if (ns <= 0n) return undefined
  const date = new Date(Number(ns / 1000000n))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export async function probeApfs(source: ByteSource): Promise<boolean> {
  if (source.size < MIN_BLOCK) return false
  const head = await source.read(0, 64)
  return u32le(head, 32) === NX_MAGIC
}

interface Record {
  key: Uint8Array
  value: Uint8Array
}

class Container {
  private constructor(private readonly source: ByteSource, readonly blockSize: number, readonly blockCount: number) {}

  static async open(source: ByteSource): Promise<{ container: Container; superblock: Uint8Array }> {
    const head = await source.read(0, 64)
    const blockSize = u32le(head, 36)
    if (blockSize < MIN_BLOCK || blockSize > MAX_BLOCK || (blockSize & (blockSize - 1)) !== 0) invalid('malformed APFS container')
    const container = new Container(source, blockSize, Math.min(u64le(head, 40), Math.floor(source.size / blockSize)))
    const first = await container.block(0)
    // Block zero is a copy of some superblock; the newest valid one in the
    // checkpoint area is the state the container was left in.
    let superblock = fletcher64(first) && u32le(first, 32) === NX_MAGIC ? first : undefined
    const areaBlocks = u32le(first, 104)
    const areaBase = u64le(first, 112)
    if ((areaBlocks & 0x80000000) === 0 && areaBlocks <= 65536) {
      for (let i = 0; i < areaBlocks; i++) {
        if (areaBase + i >= container.blockCount) break
        const candidate = await container.block(areaBase + i)
        if (objectType(candidate) !== OBJECT_TYPE_NX_SUPERBLOCK || u32le(candidate, 32) !== NX_MAGIC || !fletcher64(candidate)) continue
        if (!superblock || u64leBig(candidate, 16) > u64leBig(superblock, 16)) superblock = candidate
      }
    }
    if (!superblock) invalid('APFS container has no valid superblock')
    return { container, superblock }
  }

  block(address: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(address) || address < 0 || address >= this.blockCount) invalid('APFS block address out of range')
    return this.source.read(address * this.blockSize, this.blockSize)
  }

  async object(address: number, type: number): Promise<Uint8Array> {
    const block = await this.block(address)
    if (!fletcher64(block)) invalid('APFS object checksum does not match')
    if (objectType(block) !== type) invalid('unexpected APFS object type')
    return block
  }

  extents(list: Extent[], size: number): ByteSource {
    return new ExtentSource(this.source, list, size)
  }

  /** Every leaf record of a B-tree; `resolve` turns a child's ID into its block. */
  async records(rootAddress: number, resolve: (oid: number) => number): Promise<Record[]> {
    const root = await this.object(rootAddress, OBJECT_TYPE_BTREE)
    const info = root.subarray(root.length - BTREE_INFO_SIZE)
    const keySize = u32le(info, 8)
    const valueSize = u32le(info, 12)
    const records: Record[] = []
    const visited = new Set<number>()
    const stack: { node: Uint8Array; depth: number }[] = [{ node: root, depth: 0 }]
    while (stack.length > 0) {
      const { node, depth } = stack.pop()!
      const flags = u16le(node, 32)
      const level = u16le(node, 34)
      const count = u32le(node, 36)
      const tableStart = 56 + u16le(node, 40)
      const keyStart = tableStart + u16le(node, 42)
      const valueEnd = flags & BTNODE_ROOT ? node.length - BTREE_INFO_SIZE : node.length
      const fixed = (flags & BTNODE_FIXED_KV_SIZE) !== 0
      if (depth > MAX_TREE_DEPTH || keyStart > valueEnd || count > (keyStart - tableStart) / (fixed ? 4 : 8)) {
        invalid('malformed APFS B-tree node')
      }
      const children: number[] = []
      for (let i = 0; i < count; i++) {
        const entry = tableStart + i * (fixed ? 4 : 8)
        const keyOffset = u16le(node, entry)
        const keyLength = fixed ? keySize : u16le(node, entry + 2)
        const valueOffset = u16le(node, entry + (fixed ? 2 : 4))
        const valueLength = level > 0 ? 8 : fixed ? valueSize : u16le(node, entry + 6)
        const keyAt = keyStart + keyOffset
        const valueAt = valueEnd - valueOffset
        if (keyAt + keyLength > valueEnd || valueAt < keyStart || valueAt + valueLength > valueEnd) invalid('malformed APFS B-tree record')
        if (level > 0) children.push(u64le(node, valueAt))
        else records.push({ key: node.subarray(keyAt, keyAt + keyLength), value: node.subarray(valueAt, valueAt + valueLength) })
      }
      for (let i = children.length - 1; i >= 0; i--) {
        const address = resolve(children[i])
        if (visited.has(address)) invalid('APFS B-tree nodes form a loop')
        visited.add(address)
        const child = await this.object(address, OBJECT_TYPE_BTREE_NODE)
        if (u16le(child, 34) !== level - 1) invalid('malformed APFS B-tree levels')
        stack.push({ node: child, depth: depth + 1 })
      }
    }
    return records
  }

  /** Reads an object map into virtual ID -> block address, newest version at or before `xid`. */
  async objectMap(address: number, xid: bigint): Promise<Map<number, number>> {
    const omap = await this.object(address, OBJECT_TYPE_OMAP)
    const records = await this.records(u64le(omap, 48), oid => oid)
    const newest = new Map<number, { xid: bigint; address: number; flags: number }>()
    for (const { key, value } of records) {
      const oid = u64le(key, 0)
      const version = u64leBig(key, 8)
      if (version > xid) continue
      const current = newest.get(oid)
      if (!current || version > current.xid) newest.set(oid, { xid: version, address: u64le(value, 8), flags: u32le(value, 0) })
    }
    const map = new Map<number, number>()
    for (const [oid, entry] of newest) {
      if (entry.flags & OMAP_VAL_ENCRYPTED) unsupported('encrypted APFS volumes')
      if (!(entry.flags & OMAP_VAL_DELETED)) map.set(oid, entry.address)
    }
    return map
  }
}

interface Inode {
  privateId: number
  mode: number
  bsdFlags: number
  modified?: string
  size: number
}

interface DirectoryRecord {
  name: string
  fileId: number
}

interface Attribute {
  embedded?: Uint8Array
  stream?: { id: number; size: number }
}

function inodeOf(value: Uint8Array): Inode {
  let size = 0
  // Extended fields follow the fixed part: a count, then their headers, then
  // their data, each padded to eight bytes.
  if (value.length >= 96) {
    const count = u16le(value, 92)
    let data = 96 + count * 4
    for (let i = 0; i < count; i++) {
      const type = value[96 + i * 4]
      const length = u16le(value, 96 + i * 4 + 2)
      if (type === INO_EXT_TYPE_DSTREAM) size = u64le(value, data)
      data += (length + 7) & ~7
    }
  }
  return {
    privateId: u64le(value, 8), mode: u16le(value, 80), bsdFlags: u32le(value, 68),
    modified: nanosecondsToIso(u64leBig(value, 24)), size
  }
}

/** Lists every volume in an APFS container. */
export async function readApfs(source: ByteSource, budget: EntryBudget): Promise<Volume[]> {
  const { container, superblock } = await Container.open(source)
  const xid = u64leBig(superblock, 16)
  const containerMap = await container.objectMap(u64le(superblock, 160), xid)
  const volumes: Volume[] = []
  const slots = Math.min(u32le(superblock, 180), 100)
  for (let i = 0; i < slots; i++) {
    const oid = u64le(superblock, 184 + i * 8)
    if (oid === 0) continue
    const address = containerMap.get(oid)
    if (address === undefined) invalid('APFS volume is missing from the object map')
    volumes.push(await readVolume(container, await container.object(address, OBJECT_TYPE_FS), xid, budget))
  }
  return volumes
}

async function readVolume(container: Container, superblock: Uint8Array, xid: bigint, budget: EntryBudget): Promise<Volume> {
  if (u32le(superblock, 32) !== APFS_MAGIC) invalid('malformed APFS volume superblock')
  if (!(u32le(superblock, 264) & APFS_FS_UNENCRYPTED)) unsupported('encrypted APFS volumes')
  const incompatible = u32le(superblock, 56)
  if (incompatible & INCOMPAT_SEALED_VOLUME) unsupported('sealed APFS volumes')
  const hashedNames = (incompatible & (INCOMPAT_CASE_INSENSITIVE | INCOMPAT_NORMALIZATION_INSENSITIVE)) !== 0
  const name = cString(superblock.subarray(704, 960))
  const volumeMap = await container.objectMap(u64le(superblock, 128), xid)
  const treeIsPhysical = (u32le(superblock, 116) & STORAGE_MASK) === OBJ_PHYSICAL
  const resolve = (oid: number) => {
    if (treeIsPhysical) return oid
    const address = volumeMap.get(oid)
    if (address === undefined) invalid('APFS tree node is missing from the object map')
    return address
  }
  const records = await container.records(resolve(u64le(superblock, 136)), resolve)

  const inodes = new Map<number, Inode>()
  const children = new Map<number, DirectoryRecord[]>()
  const extents = new Map<number, Extent[]>()
  const attributes = new Map<number, Map<string, Attribute>>()
  for (const { key, value } of records) {
    const [id, type] = splitKey(key)
    if (type === TYPE_INODE) {
      inodes.set(id, inodeOf(value))
    } else if (type === TYPE_DIR_REC) {
      const nameLength = hashedNames ? u32le(key, 8) & 0x3ff : u16le(key, 8)
      const nameAt = hashedNames ? 12 : 10
      if (nameAt + nameLength > key.length) invalid('malformed APFS directory record')
      const list = children.get(id) ?? []
      list.push({ name: cString(key.subarray(nameAt, nameAt + nameLength)), fileId: u64le(value, 0) })
      children.set(id, list)
    } else if (type === TYPE_FILE_EXTENT) {
      const length = (u32le(value, 4) & 0x00ffffff) * 0x100000000 + u32le(value, 0)
      const block = u64le(value, 8)
      const list = extents.get(id) ?? []
      list.push({ logical: u64le(key, 8), physical: block === 0 ? undefined : block * container.blockSize, length })
      extents.set(id, list)
    } else if (type === TYPE_XATTR) {
      const nameLength = u16le(key, 8)
      if (10 + nameLength > key.length) invalid('malformed APFS attribute record')
      const flags = u16le(value, 0)
      const length = u16le(value, 2)
      const data = value.subarray(4, 4 + length)
      if (data.length !== length) invalid('malformed APFS attribute record')
      const attribute: Attribute = flags & XATTR_DATA_EMBEDDED ? { embedded: data }
        : flags & XATTR_DATA_STREAM ? { stream: { id: u64le(data, 0), size: u64le(data, 8) } } : {}
      const map = attributes.get(id) ?? new Map<string, Attribute>()
      map.set(cString(key.subarray(10, 10 + nameLength)), attribute)
      attributes.set(id, map)
    }
  }

  const stream = (id: number, size: number) => container.extents(extents.get(id) ?? [], size)
  const attributeBytes = async (attribute: Attribute | undefined): Promise<Uint8Array | undefined> => {
    if (!attribute) return undefined
    if (attribute.embedded) return attribute.embedded
    if (!attribute.stream) return undefined
    if (attribute.stream.size > MAX_ATTRIBUTE_BYTES) invalid('attribute is too large')
    return stream(attribute.stream.id, attribute.stream.size).read(0, attribute.stream.size)
  }

  const entries: VolumeEntry[] = []
  const sorted = (id: number) => (children.get(id) ?? []).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const visited = new Set<number>([ROOT_DIR_INO])
  const stack = [{ items: sorted(ROOT_DIR_INO), index: 0, prefix: '' }]
  while (stack.length > 0) {
    const level = stack[stack.length - 1]
    if (level.index >= level.items.length) {
      stack.pop()
      continue
    }
    const record = level.items[level.index++]
    const inode = inodes.get(record.fileId)
    if (!inode) invalid('APFS directory record points at a missing inode')
    const path = level.prefix ? `${level.prefix}/${record.name}` : record.name
    const modified = inode.modified
    budget.take()
    if ((inode.mode & S_IFMT) === S_IFDIR) {
      if (visited.has(record.fileId)) invalid('APFS directories form a loop')
      visited.add(record.fileId)
      entries.push({ path, isDirectory: true, isLink: false, size: 0, mode: inode.mode, date: modified })
      stack.push({ items: sorted(record.fileId), index: 0, prefix: path })
      continue
    }
    const fileAttributes = attributes.get(record.fileId)
    if ((inode.mode & S_IFMT) === S_IFLNK) {
      const target = await attributeBytes(fileAttributes?.get(SYMLINK_ATTRIBUTE))
      if (!target) invalid('APFS symbolic link has no target')
      const linkTarget = cString(target)
      const bytes = new TextEncoder().encode(linkTarget)
      entries.push({ path, isDirectory: false, isLink: true, linkTarget, size: bytes.length, mode: inode.mode, date: modified,
        content: async function* () { yield bytes } })
      continue
    }
    const compression = inode.bsdFlags & UF_COMPRESSED ? await attributeBytes(fileAttributes?.get(DECMPFS_ATTRIBUTE)) : undefined
    if (compression) {
      const fork = fileAttributes?.get(RESOURCE_FORK_ATTRIBUTE)?.stream
      const resource = decmpfsUsesResourceFork(compression) && fork ? stream(fork.id, fork.size) : undefined
      entries.push({ path, isDirectory: false, isLink: false, size: decmpfsSize(compression), mode: inode.mode, date: modified,
        content: () => readDecmpfs(compression, resource) })
      continue
    }
    const data = stream(inode.privateId, inode.size)
    entries.push({ path, isDirectory: false, isLink: false, size: inode.size, mode: inode.mode, date: modified, content: () => readSource(data) })
  }
  return { name, entries }
}
