import { Crc32, crc32, Lzma2StreamDecoder } from 'libera7z'

// A reader for the `.xz` container, which frames the LZMA2 the 7z library
// already decodes. Only the framing is here: the stream and block headers, the
// index and the footer, and the integrity check each block carries.
//
// It is fed compressed bytes and drained of decoded ones, so a `.tar.xz` is
// unpacked as it is read rather than held whole. That matters as much for
// safety as for memory: the extractor's limits count bytes as they land, and a
// reader that decoded everything up front would have spent the memory a
// decompression bomb was asking for before any of them applied.

const STREAM_MAGIC = Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)
const FOOTER_MAGIC = Uint8Array.of(0x59, 0x5a)
const LZMA2_FILTER_ID = 0x21n
const INDEX_INDICATOR = 0x00

/** Bytes each check type puts after a block; the index is the type itself. */
const CHECK_SIZES: Record<number, number> = { 0x00: 0, 0x01: 4, 0x02: 4, 0x03: 4, 0x04: 8, 0x05: 8, 0x06: 8, 0x0a: 32 }

export class XzFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XzFormatError'
  }
}

const invalid = (message: string): never => { throw new XzFormatError(message) }

/** True when the first bytes of a file are an xz stream header. */
export function hasXzSignature(prefix: Uint8Array): boolean {
  return prefix.length >= STREAM_MAGIC.length && STREAM_MAGIC.every((byte, index) => prefix[index] === byte)
}

const CRC64_TABLE = (() => {
  // ECMA-182, the polynomial xz uses, reflected.
  const table = new BigUint64Array(256)
  const polynomial = 0xc96c5795d7870f42n
  for (let index = 0; index < 256; index += 1) {
    let value = BigInt(index)
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1n ? (value >> 1n) ^ polynomial : value >> 1n
    }
    table[index] = value
  }
  return table
})()

function crc64(bytes: Uint8Array, seed = 0xffffffffffffffffn): bigint {
  let value = seed
  for (const byte of bytes) {
    value = CRC64_TABLE[Number((value ^ BigInt(byte)) & 0xffn)] ^ (value >> 8n)
  }
  return value
}

/** What the reader is waiting for next. */
type Phase = 'stream-header' | 'block-header' | 'block-data' | 'block-check' | 'index' | 'footer' | 'done'

/**
 * Decodes an xz stream in pieces. Push compressed bytes, then pull decoded ones
 * until nothing comes back, and call `end` once the file is exhausted.
 */
export class XzStreamDecoder {
  private pending: Uint8Array[] = []
  private pendingLength = 0
  private offset = 0
  private phase: Phase = 'stream-header'
  private checkType = 0
  private lzma2: Lzma2StreamDecoder | null = null
  private blockChecksum32 = new Crc32()
  private blockChecksum64 = 0xffffffffffffffffn
  private blockUnpacked = 0n
  private blockPacked = 0n
  private declaredUnpacked: bigint | undefined
  private blockDataStart = 0n
  private consumed = 0n

  get finished(): boolean {
    return this.phase === 'done'
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingLength += chunk.length
  }

  /** Decodes what it can, or returns nothing while it needs more input. */
  pull(signal?: AbortSignal): Uint8Array | undefined {
    const parts: Uint8Array[] = []
    let total = 0

    while (this.phase !== 'done') {
      const before = this.phase
      const produced = this.step(signal)
      if (produced === undefined) break
      if (produced.length > 0) { parts.push(produced); total += produced.length }
      // A step that neither produced output nor moved on has run out of input.
      if (produced.length === 0 && this.phase === before && !this.movedWithin) break
    }

    if (total === 0) return undefined
    if (parts.length === 1) return parts[0]
    const out = new Uint8Array(total)
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }

  /** Rejects a file that stops before the stream is complete. */
  end(): void {
    if (this.phase !== 'done') invalid('Truncated xz stream')
  }

  private movedWithin = false

  private step(signal?: AbortSignal): Uint8Array | undefined {
    this.movedWithin = false
    switch (this.phase) {
      case 'stream-header': return this.readStreamHeader()
      case 'block-header': return this.readBlockHeader()
      case 'block-data': return this.readBlockData(signal)
      case 'block-check': return this.readBlockCheck()
      case 'index': return this.readIndex()
      case 'footer': return this.readFooter()
      default: return undefined
    }
  }

  private readStreamHeader(): Uint8Array | undefined {
    const header = this.peek(12)
    if (!header) return undefined
    if (!hasXzSignature(header)) invalid('Not an xz stream')
    if (header[6] !== 0x00) invalid('Unsupported xz stream flags')
    this.checkType = header[7] & 0x0f
    if (!(this.checkType in CHECK_SIZES)) invalid(`Unsupported xz integrity check ${this.checkType}`)
    if (crc32(header.subarray(6, 8)) !== readUint32(header, 8)) invalid('xz stream header is damaged')
    this.take(12)
    this.phase = 'block-header'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  private readBlockHeader(): Uint8Array | undefined {
    const first = this.peek(1)
    if (!first) return undefined
    if (first[0] === INDEX_INDICATOR) {
      this.phase = 'index'
      this.movedWithin = true
      return new Uint8Array(0)
    }

    const size = (first[0] + 1) * 4
    const header = this.peek(size)
    if (!header) return undefined
    if (crc32(header.subarray(0, size - 4)) !== readUint32(header, size - 4)) {
      invalid('xz block header is damaged')
    }

    const cursor = { at: 1 }
    const flags = header[cursor.at++]
    if ((flags & 0x3c) !== 0) invalid('Unsupported xz block flags')
    const filterCount = (flags & 0x03) + 1
    if (flags & 0x40) readVarint(header, cursor)
    this.declaredUnpacked = flags & 0x80 ? readVarint(header, cursor) : undefined

    // The 7z library decodes LZMA2; a BCJ or delta filter in front of it is
    // legal xz that this reader has no chain for, and says so rather than
    // handing back something that decoded to noise.
    if (filterCount !== 1) invalid('xz filter chains are not supported')
    const filterId = readVarint(header, cursor)
    if (filterId !== LZMA2_FILTER_ID) invalid(`Unsupported xz filter 0x${filterId.toString(16)}`)
    const propertySize = readVarint(header, cursor)
    if (propertySize !== 1n) invalid('Unsupported xz LZMA2 properties')
    const dictionaryProperty = header[cursor.at++]

    this.lzma2 = new Lzma2StreamDecoder(dictionaryProperty)
    this.blockChecksum32 = new Crc32()
    this.blockChecksum64 = 0xffffffffffffffffn
    this.blockUnpacked = 0n
    this.blockDataStart = this.consumed + BigInt(size)
    this.take(size)
    this.phase = 'block-data'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  private readBlockData(signal?: AbortSignal): Uint8Array | undefined {
    const decoder = this.lzma2!
    const available = this.buffered
    if (available > 0) {
      decoder.push(this.peek(available)!.slice())
      this.take(available)
    }

    const decoded = decoder.pull(signal)
    if (decoded && decoded.length > 0) {
      this.blockUnpacked += BigInt(decoded.length)
      this.accumulateCheck(decoded)
      this.movedWithin = true
      return decoded
    }

    if (!decoder.finished) return undefined

    // The chunk cursor stops on the end marker; whatever it did not claim is
    // the block's padding and check, which belong to this reader again.
    const leftover = decoder.drainRemaining()
    this.blockPacked = this.consumed - this.blockDataStart - BigInt(leftover.length)
    if (this.declaredUnpacked !== undefined && this.declaredUnpacked !== this.blockUnpacked) {
      invalid('xz block does not expand to the size it declares')
    }
    this.unread(leftover)
    this.phase = 'block-check'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  private readBlockCheck(): Uint8Array | undefined {
    const padding = Number((4n - (this.blockPacked % 4n)) % 4n)
    const checkSize = CHECK_SIZES[this.checkType]
    const trailer = this.peek(padding + checkSize)
    if (!trailer) return undefined
    for (let index = 0; index < padding; index += 1) {
      if (trailer[index] !== 0) invalid('xz block padding is not zero')
    }
    this.verifyCheck(trailer.subarray(padding))
    this.take(padding + checkSize)
    this.lzma2 = null
    this.phase = 'block-header'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  /**
   * The index and footer describe what has already been read and verified, so
   * they are walked for length rather than checked against the blocks again.
   */
  private readIndex(): Uint8Array | undefined {
    const start = this.peek(Math.min(this.buffered, 1 + 9))
    if (!start || start.length < 2) return undefined
    const cursor = { at: 1 }
    let count: bigint
    try {
      count = readVarint(start, cursor)
    } catch {
      return undefined
    }
    // Two varints per record, each at most nine bytes, then padding and a CRC.
    const upperBound = cursor.at + Number(count) * 18 + 3 + 4
    const whole = this.peek(Math.min(this.buffered, upperBound))
    if (!whole) return undefined
    const walk = { at: cursor.at }
    for (let record = 0n; record < count; record += 1n) {
      if (walk.at + 18 > whole.length && this.buffered < upperBound) return undefined
      readVarint(whole, walk)
      readVarint(whole, walk)
    }
    const padded = walk.at + ((4 - (walk.at % 4)) % 4)
    if (this.buffered < padded + 4) return undefined
    this.take(padded + 4)
    this.phase = 'footer'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  private readFooter(): Uint8Array | undefined {
    const footer = this.peek(12)
    if (!footer) return undefined
    if (footer[10] !== FOOTER_MAGIC[0] || footer[11] !== FOOTER_MAGIC[1]) invalid('xz stream footer is damaged')
    if (crc32(footer.subarray(4, 10)) !== readUint32(footer, 0)) invalid('xz stream footer is damaged')
    this.take(12)
    // A file may hold several streams, each padded to a four byte boundary.
    this.phase = this.skipStreamPadding() ? 'stream-header' : 'done'
    this.movedWithin = true
    return new Uint8Array(0)
  }

  /** True when another stream follows the padding after this one. */
  private skipStreamPadding(): boolean {
    while (true) {
      const next = this.peek(4)
      if (!next) return false
      if (next[0] === 0 && next[1] === 0 && next[2] === 0 && next[3] === 0) {
        this.take(4)
        continue
      }
      return true
    }
  }

  private accumulateCheck(bytes: Uint8Array): void {
    if (this.checkType === 0x01) this.blockChecksum32.update(bytes)
    else if (this.checkType === 0x04) this.blockChecksum64 = crc64(bytes, this.blockChecksum64)
  }

  private verifyCheck(check: Uint8Array): void {
    if (this.checkType === 0x01) {
      if (readUint32(check, 0) !== this.blockChecksum32.digest()) invalid('xz block failed its CRC32 check')
      return
    }
    if (this.checkType === 0x04) {
      let stored = 0n
      for (let index = 7; index >= 0; index -= 1) stored = (stored << 8n) | BigInt(check[index])
      if (stored !== (this.blockChecksum64 ^ 0xffffffffffffffffn)) invalid('xz block failed its CRC64 check')
    }
    // Every other type is a length this reader steps over: nothing decodes
    // differently for it, and the sizes the block declares are still checked.
  }

  private get buffered(): number {
    return this.pendingLength - this.offset
  }

  /** Puts bytes the LZMA2 cursor never claimed back at the front. */
  private unread(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.compact()
    if (this.offset > 0) {
      // Trim what has been consumed so the returned bytes can sit in front.
      this.pending[0] = this.pending[0].subarray(this.offset)
      this.pendingLength -= this.offset
      this.offset = 0
    }
    this.pending.unshift(bytes)
    this.pendingLength += bytes.length
    this.consumed -= BigInt(bytes.length)
  }

  private peek(length: number): Uint8Array | undefined {
    if (length === 0) return new Uint8Array(0)
    if (this.buffered < length) return undefined
    this.compact()
    const first = this.pending[0]
    if (first.length - this.offset >= length) return first.subarray(this.offset, this.offset + length)
    const out = new Uint8Array(length)
    let at = 0
    let index = 0
    let start = this.offset
    while (at < length) {
      const part = this.pending[index]
      const take = Math.min(part.length - start, length - at)
      out.set(part.subarray(start, start + take), at)
      at += take
      index += 1
      start = 0
    }
    return out
  }

  private take(length: number): void {
    this.offset += length
    this.consumed += BigInt(length)
    this.compact()
  }

  private compact(): void {
    while (this.pending.length > 0 && this.offset >= this.pending[0].length) {
      this.offset -= this.pending[0].length
      this.pendingLength -= this.pending[0].length
      this.pending.shift()
    }
  }
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
}

/** xz's multibyte integer: base 128, little endian, high bit continues. */
function readVarint(bytes: Uint8Array, cursor: { at: number }): bigint {
  let value = 0n
  for (let index = 0; index < 9; index += 1) {
    if (cursor.at >= bytes.length) invalid('Truncated xz integer')
    const byte = bytes[cursor.at++]
    value |= BigInt(byte & 0x7f) << BigInt(index * 7)
    if ((byte & 0x80) === 0) {
      if (byte === 0 && index > 0) invalid('Non-minimal xz integer')
      return value
    }
  }
  return invalid('xz integer is too long')
}
