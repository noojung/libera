import { invalidArchive, throwIfCancelled } from './errors.js'
import { LzmaDecoder } from './lzma.js'
import { dictionarySizeFromProperty, initialLzma2ChunkState, planLzma2Chunk } from './lzma2.js'

/**
 * Streaming LZMA2 decoder, fed compressed bytes and drained of decoded ones.
 *
 * LZMA2 frames itself: every chunk declares how much it packs and unpacks, and
 * a zero control byte ends the stream, so the size of the whole is never needed
 * and the caller can be handed output long before the input runs out. That is
 * what a container which does not declare the expanded size - `.xz` - needs,
 * and what keeps the memory to the dictionary plus one chunk rather than to the
 * size of the file.
 *
 * `decodeLzma2` stays the one-shot form for a buffer already in hand.
 */
export class Lzma2StreamDecoder {
  private readonly decoder: LzmaDecoder
  private readonly state = initialLzma2ChunkState()
  private pending: Uint8Array[] = []
  private pendingLength = 0
  private offset = 0
  private ended = false

  constructor(dictionaryProperty: number) {
    this.decoder = new LzmaDecoder(dictionarySizeFromProperty(dictionaryProperty))
  }

  /** True once the stream's end marker has been read. */
  get finished(): boolean {
    return this.ended
  }

  /** Adds compressed bytes. They are decoded by `pull`, not here. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingLength += chunk.length
  }

  /**
   * Decodes whatever complete chunks have arrived, or nothing when the next
   * one is still short of bytes. Call it until it returns nothing, push more,
   * and call again.
   */
  pull(signal?: AbortSignal): Uint8Array | undefined {
    if (this.ended) return undefined
    const decoded: Uint8Array[] = []
    let total = 0

    while (!this.ended) {
      throwIfCancelled(signal)
      const framed = this.readChunk(signal)
      if (!framed) break
      if (framed.length > 0) {
        decoded.push(framed)
        total += framed.length
      }
    }

    if (total === 0) return undefined
    if (decoded.length === 1) return decoded[0]
    const out = new Uint8Array(total)
    let at = 0
    for (const part of decoded) { out.set(part, at); at += part.length }
    return out
  }

  /** Rejects a stream that stopped before its end marker. */
  end(): void {
    if (!this.ended) throw invalidArchive('Truncated LZMA2 stream')
  }

  /** Bytes pushed that no chunk has claimed yet. */
  get buffered(): number {
    return this.pendingLength - this.offset
  }

  /**
   * Hands back the bytes past the end marker and forgets them. A container
   * feeds this decoder without knowing where its stream stops, so whatever it
   * over-fed belongs to the container again.
   */
  drainRemaining(): Uint8Array {
    const length = this.buffered
    const out = length === 0 ? new Uint8Array(0) : this.peek(length)!.slice()
    this.pending = []
    this.pendingLength = 0
    this.offset = 0
    return out
  }

  /** Reads one whole chunk, or nothing while it is still incomplete. */
  private readChunk(signal?: AbortSignal): Uint8Array | undefined {
    const header = this.peek(1)
    if (!header) return undefined
    const control = header[0]

    if (control === 0) {
      planLzma2Chunk(control, this.state)
      this.take(1)
      this.ended = true
      return new Uint8Array(0)
    }

    if (control === 1 || control === 2) {
      const size = this.peek(3)
      if (!size) return undefined
      const length = ((size[1] << 8) | size[2]) + 1
      const whole = this.peek(3 + length)
      if (!whole) return undefined
      const plan = planLzma2Chunk(control, this.state)
      if (plan.resetDictionary) this.decoder.resetDictionary()
      const bytes = whole.slice(3, 3 + length)
      this.decoder.writeUncompressed(bytes)
      this.take(3 + length)
      return bytes
    }

    if (control < 0x80) throw invalidArchive('Invalid LZMA2 control byte')

    // Control, two unpacked-size bytes, two packed-size bytes, and the
    // properties byte when the control asks for it.
    const sizes = this.peek(5)
    if (!sizes) return undefined
    const unpacked = (((control & 0x1f) << 16) | (sizes[1] << 8) | sizes[2]) + 1
    const packed = ((sizes[3] << 8) | sizes[4]) + 1
    const headerSize = control >= 0xc0 ? 6 : 5
    const whole = this.peek(headerSize + packed)
    if (!whole) return undefined

    const plan = planLzma2Chunk(control, this.state)
    if (plan.resetDictionary) this.decoder.resetDictionary()
    if (plan.readProperties) this.decoder.setProperties(whole[5])
    if (plan.resetState) this.decoder.resetState()

    const decoded = this.decoder.decodeChunk(whole.slice(headerSize, headerSize + packed), unpacked, signal)
    this.take(headerSize + packed)
    return decoded
  }

  /** The next `length` buffered bytes, or nothing when fewer have arrived. */
  private peek(length: number): Uint8Array | undefined {
    if (this.buffered < length) return undefined
    this.compact()
    const first = this.pending[0]
    if (first.length - this.offset >= length) {
      return first.subarray(this.offset, this.offset + length)
    }
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

  /** Drops `length` bytes once a chunk has been read out of them. */
  private take(length: number): void {
    this.offset += length
    this.compact()
  }

  /** Releases buffers the cursor has moved past. */
  private compact(): void {
    while (this.pending.length > 0 && this.offset >= this.pending[0].length) {
      this.offset -= this.pending[0].length
      this.pendingLength -= this.pending[0].length
      this.pending.shift()
    }
  }
}
