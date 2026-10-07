import { deflateSync } from 'zlib'
import { crc32 } from 'libera7z'

// Tiny synthetic UDIF + HFS+ images, built entirely in JS on every test OS.
// Layout follows Apple's HFS Plus volume/catalog and UDIF blkx structures.
type FixtureFile = { name: string; data: Buffer; mode?: number }

export function dmgFixture(files: FixtureFile[]): Buffer {
  return udifImage(hfsDisk(files))
}

/** An HFS+ volume named `Fixture` holding `files`, as a raw disk. */
export function hfsDisk(files: FixtureFile[]): Buffer {
  const catalog = Buffer.alloc(8192)
  catalog[8] = 1
  catalog.writeUInt16BE(1, 14)
  catalog.writeUInt32BE(1, 16)
  catalog.writeUInt32BE(files.length + 1, 20)
  catalog.writeUInt32BE(1, 24)
  catalog.writeUInt32BE(1, 28)
  catalog.writeUInt16BE(4096, 32)
  catalog.writeUInt16BE(516, 34)
  catalog.writeUInt32BE(2, 36)
  catalog[4104] = 0xff
  catalog[4105] = 1
  catalog.writeUInt16BE(files.length + 1, 4106)
  const records: Buffer[] = []
  let nextBlock = 24
  const data: { position: number; bytes: Buffer }[] = []
  const fork = (buffer: Buffer, offset: number, size: number, start: number, blocks: number) => {
    buffer.writeBigUInt64BE(BigInt(size), offset)
    buffer.writeUInt32BE(blocks, offset + 12)
    buffer.writeUInt32BE(start, offset + 16)
    buffer.writeUInt32BE(blocks, offset + 20)
  }
  for (const [index, file] of [{ name: 'Fixture', data: Buffer.alloc(0), mode: 0o040755 }, ...files].entries()) {
    const isDirectory = index === 0
    const name = Buffer.from(file.name, 'utf16le').swap16()
    const key = Buffer.alloc(8 + name.length)
    key.writeUInt16BE(6 + name.length)
    key.writeUInt32BE(isDirectory ? 1 : 2, 2)
    key.writeUInt16BE(name.length / 2, 6)
    name.copy(key, 8)
    const record = Buffer.alloc(isDirectory ? 88 : 248)
    record.writeUInt16BE(isDirectory ? 1 : 2)
    record.writeUInt32BE(isDirectory ? 2 : 15 + index, 8)
    record.writeUInt32BE(2082844800 + 1700000000, 16)
    record.writeUInt16BE(file.mode ?? 0o100644, 42)
    if (!isDirectory) {
      const blocks = Math.ceil(file.data.length / 512)
      fork(record, 88, file.data.length, nextBlock, blocks)
      data.push({ position: nextBlock * 512, bytes: file.data })
      nextBlock += blocks
    }
    records.push(Buffer.concat([key, record]))
  }
  let recordOffset = 14
  for (const [index, record] of records.entries()) {
    catalog.writeUInt16BE(recordOffset, 8190 - index * 2)
    record.copy(catalog, 4096 + recordOffset)
    recordOffset += record.length
  }
  catalog.writeUInt16BE(recordOffset, 8190 - records.length * 2)
  const image = Buffer.alloc((nextBlock + 2) * 512)
  image.write('H+', 1024)
  image.writeUInt16BE(4, 1026)
  image.writeUInt32BE(files.length, 1056)
  image.writeUInt32BE(512, 1064)
  image.writeUInt32BE(image.length / 512, 1068)
  fork(image, 1024 + 272, catalog.length, 8, 16)
  catalog.copy(image, 4096)
  for (const item of data) item.bytes.copy(image, item.position)
  return image
}

/**
 * Wraps a raw disk as a one-partition UDIF image, its sectors in one chunk:
 * deflated as hdiutil's UDZO would, or stored raw.
 */
export function udifImage(disk: Buffer, method: 'zlib' | 'raw' = 'zlib'): Buffer {
  const sectors = disk.length / 512
  const compressed = method === 'zlib' ? deflateSync(disk) : disk
  const table = Buffer.alloc(284)
  table.write('mish')
  table.writeUInt32BE(1, 4)
  table.writeBigUInt64BE(BigInt(sectors), 16)
  table.writeUInt32BE(sectors, 32)
  table.writeUInt32BE(2, 64)
  table.writeUInt32BE(32, 68)
  table.writeUInt32BE(crc32(disk), 72)
  table.writeUInt32BE(2, 200)
  table.writeUInt32BE(method === 'zlib' ? 0x80000005 : 1, 204)
  table.writeBigUInt64BE(BigInt(sectors), 220)
  table.writeBigUInt64BE(BigInt(compressed.length), 236)
  table.writeUInt32BE(0xffffffff, 244)
  table.writeBigUInt64BE(BigInt(sectors), 252)
  table.writeBigUInt64BE(BigInt(compressed.length), 268)
  const xml = Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array><dict><key>Name</key><string>disk image (Apple_HFS : 0)</string><key>ID</key><string>0</string><key>Attributes</key><string>0x0050</string><key>Data</key><data>${table.toString('base64')}</data></dict></array></dict></dict></plist>`)
  const trailer = Buffer.alloc(512)
  trailer.write('koly')
  trailer.writeUInt32BE(4, 4)
  trailer.writeUInt32BE(512, 8)
  trailer.writeUInt32BE(1, 12)
  trailer.writeBigUInt64BE(BigInt(compressed.length), 32)
  trailer.writeUInt32BE(1, 56)
  trailer.writeUInt32BE(1, 60)
  trailer.writeBigUInt64BE(BigInt(compressed.length), 216)
  trailer.writeBigUInt64BE(BigInt(xml.length), 224)
  trailer.writeUInt32BE(1, 488)
  trailer.writeBigUInt64BE(BigInt(sectors), 492)
  return Buffer.concat([compressed, xml, trailer])
}
