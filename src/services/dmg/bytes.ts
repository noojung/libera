import { promisify } from 'util'
import zlib from 'zlib'

// Shared plumbing for the DMG readers: errors, bounds-checked field reads and
// random access over byte ranges. Every structure in a disk image comes from
// an untrusted file, so a field read past its buffer is an error, never an
// `undefined` quietly turned into NaN.

export class DmgFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DmgFormatError'
  }
}

export function invalid(message: string): never {
  throw new DmgFormatError(`Invalid DMG: ${message}`)
}

export function unsupported(message: string): never {
  throw new DmgFormatError(`Unsupported DMG: ${message}`)
}

function check(bytes: Uint8Array, offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > bytes.length) invalid('truncated structure')
}

export function u8(bytes: Uint8Array, offset: number): number {
  check(bytes, offset, 1)
  return bytes[offset]
}

export function u16be(bytes: Uint8Array, offset: number): number {
  check(bytes, offset, 2)
  return bytes[offset] << 8 | bytes[offset + 1]
}

export function u32be(bytes: Uint8Array, offset: number): number {
  check(bytes, offset, 4)
  return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0
}

export function u64be(bytes: Uint8Array, offset: number): number {
  return safe(u32be(bytes, offset), u32be(bytes, offset + 4))
}

export function u16le(bytes: Uint8Array, offset: number): number {
  check(bytes, offset, 2)
  return bytes[offset] | bytes[offset + 1] << 8
}

export function u32le(bytes: Uint8Array, offset: number): number {
  check(bytes, offset, 4)
  return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0
}

export function u64le(bytes: Uint8Array, offset: number): number {
  return safe(u32le(bytes, offset + 4), u32le(bytes, offset))
}

/** A 64-bit field as a bigint, for the few that carry flags in their top bits. */
export function u64leBig(bytes: Uint8Array, offset: number): bigint {
  return BigInt(u32le(bytes, offset + 4)) << 32n | BigInt(u32le(bytes, offset))
}

const inflate = promisify(zlib.inflate)

/** Inflates a zlib stream that must expand to exactly `size` bytes. */
export async function inflateExact(packed: Uint8Array, size: number): Promise<Uint8Array> {
  let out: Buffer
  try {
    out = await inflate(packed, { maxOutputLength: Math.max(size, 1) })
  } catch {
    invalid('zlib data could not be decoded')
  }
  if (out.length !== size) invalid('zlib data size does not match')
  return out
}

function safe(high: number, low: number): number {
  if (high >= 0x200000) invalid('64-bit field out of range')
  return high * 0x100000000 + low
}

export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  check(bytes, offset, length)
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

export function utf16be(bytes: Uint8Array, offset: number, units: number): string {
  check(bytes, offset, units * 2)
  let text = ''
  for (let i = 0; i < units; i++) text += String.fromCharCode(bytes[offset + i * 2] << 8 | bytes[offset + i * 2 + 1])
  return text
}

export function utf16le(bytes: Uint8Array, offset: number, units: number): string {
  check(bytes, offset, units * 2)
  let text = ''
  for (let i = 0; i < units; i++) text += String.fromCharCode(bytes[offset + i * 2] | bytes[offset + i * 2 + 1] << 8)
  return text
}

/** Random access over a byte range: the image file, its decoded disk, or a partition of it. */
export interface ByteSource {
  readonly size: number
  read(position: number, length: number): Promise<Uint8Array>
}

/** A window onto part of another source; reads outside it are errors. */
export class SliceSource implements ByteSource {
  constructor(private readonly parent: ByteSource, private readonly offset: number, readonly size: number) {
    if (offset < 0 || size < 0 || offset + size > parent.size) invalid('volume extends past the end of the disk')
  }

  read(position: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 ||
        position + length > this.size) {
      invalid('read past the end of a volume')
    }
    return this.parent.read(this.offset + position, length)
  }
}

/** Part of a file: `length` bytes at `logical`, stored at `physical`, or a hole of zeros. */
export interface Extent {
  logical: number
  physical?: number
  length: number
}

/** A file's bytes, gathered from wherever its extents put them on the volume. */
export class ExtentSource implements ByteSource {
  private readonly extents: Extent[]

  constructor(private readonly volume: ByteSource, extents: Extent[], readonly size: number) {
    this.extents = [...extents].sort((a, b) => a.logical - b.logical)
    let end = 0
    for (const extent of this.extents) {
      if (extent.logical < end || !Number.isSafeInteger(extent.logical + extent.length)) invalid('overlapping file extents')
      if (extent.physical !== undefined && extent.physical + extent.length > volume.size) invalid('file extent lies outside its volume')
      end = extent.logical + extent.length
    }
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (position < 0 || length < 0 || position + length > this.size) invalid('read past the end of a file')
    const out = new Uint8Array(length)
    const end = position + length
    let low = 0
    let high = this.extents.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.extents[mid].logical + this.extents[mid].length <= position) low = mid + 1
      else high = mid
    }
    // Anything no extent covers is a hole, and reads as zeros.
    for (let i = low; i < this.extents.length && this.extents[i].logical < end; i++) {
      const extent = this.extents[i]
      if (extent.physical === undefined) continue
      const from = Math.max(position, extent.logical)
      const to = Math.min(end, extent.logical + extent.length)
      out.set(await this.volume.read(extent.physical + from - extent.logical, to - from), from - position)
    }
    return out
  }
}

export const CONTENT_CHUNK_BYTES = 256 * 1024

/** Streams a source in pieces small enough for a reader to stop between them. */
export async function* readSource(source: ByteSource): AsyncGenerator<Uint8Array> {
  for (let done = 0; done < source.size; done += CONTENT_CHUNK_BYTES) {
    yield await source.read(done, Math.min(CONTENT_CHUNK_BYTES, source.size - done))
  }
}

/** One entry of a volume, relative to its root. */
export interface VolumeEntry {
  path: string
  isDirectory: boolean
  isLink: boolean
  linkTarget?: string
  size: number
  mode?: number
  date?: string
  content?: () => AsyncIterable<Uint8Array>
}

export interface Volume {
  name: string
  entries: VolumeEntry[]
}

/** Guards a volume walk against more entries than the caller allows. */
export class EntryBudget {
  private count = 0
  constructor(private readonly limit: number, private readonly onExceeded: () => never) {}

  take(): void {
    if (++this.count > this.limit) this.onExceeded()
  }
}
