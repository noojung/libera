import { ascii, type ByteSource, u16be, u32be, u32le, u64le } from './bytes'

// The partition map of a decoded disk: GPT, Apple's partition map, or MBR.
// hdiutil also names every partition in the image's resource map, but an image
// written by another tool may keep a whole partitioned disk in one entry, so
// the map on the disk itself is read too. Partitions only say where to look;
// the filesystem probes decide what is there.

const SECTOR = 512
const MAX_PARTITIONS = 256

export interface PartitionRange {
  offset: number
  length: number
}

export async function readPartitionMap(disk: ByteSource): Promise<PartitionRange[]> {
  if (disk.size < SECTOR * 2) return []
  const head = await disk.read(0, SECTOR * 2)
  const ranges: PartitionRange[] = []
  const add = (offset: number, length: number) => {
    if (length > 0 && Number.isSafeInteger(offset + length) && offset + length <= disk.size && ranges.length < MAX_PARTITIONS) {
      ranges.push({ offset, length })
    }
  }

  if (ascii(head, SECTOR, 8) === 'EFI PART') {
    const tableAt = u64le(head, SECTOR + 72) * SECTOR
    const count = Math.min(u32le(head, SECTOR + 80), MAX_PARTITIONS)
    const entrySize = u32le(head, SECTOR + 84)
    if (entrySize >= 128 && entrySize <= 4096 && tableAt + count * entrySize <= disk.size) {
      const table = await disk.read(tableAt, count * entrySize)
      for (let i = 0; i < count; i++) {
        const entry = table.subarray(i * entrySize, (i + 1) * entrySize)
        if (entry.subarray(0, 16).every(byte => byte === 0)) continue
        const first = u64le(entry, 32)
        const last = u64le(entry, 40)
        if (last >= first) add(first * SECTOR, (last - first + 1) * SECTOR)
      }
    }
    return ranges
  }

  if (ascii(head, 0, 2) === 'ER' && ascii(head, SECTOR, 2) === 'PM') {
    const declared = u16be(head, 2)
    const blockSize = declared >= SECTOR && declared <= 4096 && (declared & (declared - 1)) === 0 ? declared : SECTOR
    const count = Math.min(u32be(head, SECTOR + 4), MAX_PARTITIONS)
    if ((count + 1) * SECTOR <= disk.size) {
      const map = await disk.read(SECTOR, count * SECTOR)
      for (let i = 0; i < count; i++) {
        const entry = map.subarray(i * SECTOR, (i + 1) * SECTOR)
        if (ascii(entry, 0, 2) !== 'PM') break
        add(u32be(entry, 8) * blockSize, u32be(entry, 12) * blockSize)
      }
    }
    return ranges
  }

  if (head[510] === 0x55 && head[511] === 0xaa) {
    for (let i = 0; i < 4; i++) {
      const entry = 446 + i * 16
      const type = head[entry + 4]
      if (type !== 0 && type !== 0xee) add(u32le(head, entry + 8) * SECTOR, u32le(head, entry + 12) * SECTOR)
    }
  }
  return ranges
}
