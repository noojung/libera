import type { FileHandle } from 'fs/promises'
import { decodeBzip2 } from 'libera7z'
import { XzStreamDecoder } from '../xz/reader'
import { decodeAdc } from './adc'
import { ascii, type ByteSource, inflateExact, invalid, u32be, u64be, unsupported } from './bytes'
import { decodeLzfse } from './lzfse'
import { parsePlist, type PlistValue } from './plist'

// A UDIF image - what `hdiutil` writes as a .dmg - is a disk cut into chunks,
// each stored raw, as zeros, or compressed on its own. A 512-byte `koly`
// trailer at the end of the file points at an XML property list, whose `blkx`
// entries map every run of disk sectors to the chunk that holds it.

const SECTOR = 512
const MAX_RESOURCE_MAP_BYTES = 64 * 1024 * 1024
// hdiutil writes compressed chunks of a megabyte; a chunk claiming far more is
// an attempt to make one read allocate the memory of a whole disk.
const MAX_CHUNK_BYTES = 64 * 1024 * 1024
const CACHE_BYTES = 128 * 1024 * 1024

const ZERO = 0x00000000
const RAW = 0x00000001
const IGNORED = 0x00000002
const ADC = 0x80000004
const ZLIB = 0x80000005
const BZIP2 = 0x80000006
const LZFSE = 0x80000007
const XZ = 0x80000008
const COMMENT = 0x7ffffffe
const TERMINATOR = 0xffffffff

const CODEC_NAMES: Record<number, string> = { [ADC]: 'ADC', [ZLIB]: 'zlib', [BZIP2]: 'bzip2', [LZFSE]: 'LZFSE', [XZ]: 'LZMA' }

/** The image file itself; a read that comes up short means it was truncated. */
export class FileSource implements ByteSource {
  constructor(private readonly handle: FileHandle, readonly size: number) {}

  async read(position: number, length: number): Promise<Uint8Array> {
    if (position < 0 || length < 0 || position + length > this.size) invalid('read past the end of the image file')
    const buffer = Buffer.alloc(length)
    for (let done = 0; done < length;) {
      const { bytesRead } = await this.handle.read(buffer, done, length - done, position + done)
      if (bytesRead === 0) invalid('the image file is truncated')
      done += bytesRead
    }
    return buffer
  }
}

interface Run {
  start: number
  length: number
  type: number
  packOffset: number
  packLength: number
}

/** A partition as the resource map names it: `disk image (Apple_HFS : 4)`. */
export interface UdifPartition {
  name: string
  offset: number
  length: number
}

function dict(value: PlistValue | undefined): { [key: string]: PlistValue } | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) ? value : undefined
}

function decodeXz(packed: Uint8Array, size: number): Uint8Array {
  const decoder = new XzStreamDecoder()
  decoder.push(packed)
  const out = new Uint8Array(size)
  let at = 0
  for (let part = decoder.pull(); part; part = decoder.pull()) {
    if (at + part.length > size) invalid('LZMA chunk exceeds its declared size')
    out.set(part, at)
    at += part.length
  }
  decoder.end()
  if (at !== size) invalid('LZMA chunk size does not match')
  return out
}

/** The decoded disk of a UDIF image, read at random. */
export class UdifImage implements ByteSource {
  private readonly cache = new Map<number, Promise<Uint8Array>>()
  private cachedBytes = 0

  private constructor(
    private readonly file: ByteSource,
    readonly size: number,
    private readonly runs: Run[],
    readonly partitions: UdifPartition[]
  ) {}

  static async open(file: ByteSource): Promise<UdifImage> {
    if (file.size < SECTOR) unsupported('expected an unencrypted UDIF disk image')
    const trailer = await file.read(file.size - SECTOR, SECTOR)
    if (ascii(trailer, 0, 4) !== 'koly') unsupported('expected an unencrypted UDIF disk image')
    if (u32be(trailer, 4) !== 4 || u32be(trailer, 8) !== SECTOR) unsupported('unknown UDIF trailer version')
    if (u32be(trailer, 60) > 1) unsupported('segmented disk images')
    const dataOffset = u64be(trailer, 24)
    const dataLength = u64be(trailer, 32)
    const xmlOffset = u64be(trailer, 216)
    const xmlLength = u64be(trailer, 224)
    const sectorCount = u64be(trailer, 492)
    if (xmlLength === 0) unsupported('images without an XML resource map')
    if (dataOffset + dataLength > file.size || xmlOffset + xmlLength > file.size) invalid('trailer points past the end of the file')
    if (xmlLength > MAX_RESOURCE_MAP_BYTES) invalid('resource map is too large')
    if (sectorCount > Number.MAX_SAFE_INTEGER / SECTOR) invalid('disk size out of range')

    const plist = dict(parsePlist(Buffer.from(await file.read(xmlOffset, xmlLength)).toString('utf8')))
    const blkx = dict(plist?.['resource-fork'])?.blkx
    if (!Array.isArray(blkx)) invalid('resource map has no block table')

    const runs: Run[] = []
    const partitions: UdifPartition[] = []
    for (const entry of blkx) {
      const table = dict(entry)?.Data
      if (!(table instanceof Uint8Array) || ascii(table, 0, 4) !== 'mish') invalid('malformed block table')
      const firstSector = u64be(table, 8)
      const sectors = u64be(table, 16)
      const base = dataOffset + u64be(table, 24)
      const chunkCount = u32be(table, 200)
      if (chunkCount > (table.length - 204) / 40) invalid('malformed block table')
      const name = dict(entry)?.Name
      partitions.push({ name: typeof name === 'string' ? name : '', offset: firstSector * SECTOR, length: sectors * SECTOR })
      for (let i = 0; i < chunkCount; i++) {
        const at = 204 + i * 40
        const type = u32be(table, at)
        if (type === TERMINATOR) break
        if (type === COMMENT) continue
        const count = u64be(table, at + 16)
        if (count === 0) continue
        if (type !== ZERO && type !== RAW && type !== IGNORED && !(type in CODEC_NAMES)) {
          unsupported(`image chunk type 0x${type.toString(16)}`)
        }
        const run = {
          start: (firstSector + u64be(table, at + 8)) * SECTOR,
          length: count * SECTOR,
          type,
          packOffset: base + u64be(table, at + 24),
          packLength: u64be(table, at + 32)
        }
        if (!Number.isSafeInteger(run.start + run.length)) invalid('chunk out of range')
        if (type !== ZERO && type !== IGNORED) {
          if (run.packOffset + run.packLength > dataOffset + dataLength) invalid('chunk lies outside the data fork')
          if (type === RAW ? run.packLength < run.length : run.length > MAX_CHUNK_BYTES || run.packLength > MAX_CHUNK_BYTES) {
            invalid('chunk size out of range')
          }
        }
        runs.push(run)
      }
    }
    runs.sort((a, b) => a.start - b.start)
    let size = sectorCount * SECTOR
    for (let i = 0; i < runs.length; i++) {
      if (i > 0 && runs[i].start < runs[i - 1].start + runs[i - 1].length) invalid('overlapping chunks')
      size = Math.max(size, runs[i].start + runs[i].length)
    }
    return new UdifImage(file, size, runs, partitions)
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 ||
        position + length > this.size) {
      invalid('read past the end of the disk')
    }
    const out = new Uint8Array(length)
    // The first run that ends after the position; gaps between runs read as zeros.
    let low = 0
    let high = this.runs.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.runs[mid].start + this.runs[mid].length <= position) low = mid + 1
      else high = mid
    }
    const end = position + length
    for (let i = low; i < this.runs.length && this.runs[i].start < end; i++) {
      const run = this.runs[i]
      const from = Math.max(position, run.start)
      const to = Math.min(end, run.start + run.length)
      if (run.type === ZERO || run.type === IGNORED) continue
      if (run.type === RAW) {
        out.set(await this.file.read(run.packOffset + from - run.start, to - from), from - position)
      } else {
        const decoded = await this.decode(i)
        out.set(decoded.subarray(from - run.start, to - run.start), from - position)
      }
    }
    return out
  }

  private decode(index: number): Promise<Uint8Array> {
    const cached = this.cache.get(index)
    if (cached) {
      // Map order doubles as recency, so a hit moves the chunk to the back.
      this.cache.delete(index)
      this.cache.set(index, cached)
      return cached
    }
    const run = this.runs[index]
    const decoded = this.decodeRun(run)
    this.cache.set(index, decoded)
    this.cachedBytes += run.length
    decoded.catch(() => {
      if (this.cache.get(index) === decoded) {
        this.cache.delete(index)
        this.cachedBytes -= run.length
      }
    })
    for (const [key] of this.cache) {
      if (this.cachedBytes <= CACHE_BYTES || key === index) break
      this.cache.delete(key)
      this.cachedBytes -= this.runs[key].length
    }
    return decoded
  }

  private async decodeRun(run: Run): Promise<Uint8Array> {
    const packed = await this.file.read(run.packOffset, run.packLength)
    try {
      switch (run.type) {
        case ADC: return decodeAdc(packed, run.length)
        case BZIP2: return decodeBzip2(packed, run.length)
        case LZFSE: return decodeLzfse(packed, run.length)
        case XZ: return decodeXz(packed, run.length)
        default: return await inflateExact(packed, run.length)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'DmgFormatError') throw error
      invalid(`${CODEC_NAMES[run.type]} chunk could not be decoded`)
    }
  }
}
