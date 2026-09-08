import { concatBytes } from './binary.js'
import { invalidArchive, throwIfCancelled } from './errors.js'
import { LzmaDecoder, LzmaStreamEncoder, type LzmaEncoderOptions } from './lzma.js'

const ENCODE_CHUNK_SIZE = 48 * 1024
const DEFAULT_LZMA_PROPERTIES = 93 // lc=3, lp=0, pb=2

export function dictionarySizeFromProperty(property: number): number {
  if (!Number.isInteger(property) || property < 0 || property > 40) {
    throw invalidArchive('Invalid LZMA2 dictionary property')
  }
  if (property === 40) return 0xffffffff
  return (2 | (property & 1)) * (2 ** ((property >>> 1) + 11))
}

export function dictionaryPropertyForSize(dictionarySize: number): number {
  if (!Number.isSafeInteger(dictionarySize) || dictionarySize < 4096) throw new RangeError('Invalid dictionary size')
  for (let property = 0; property < 40; property += 1) {
    if (dictionarySize <= dictionarySizeFromProperty(property)) return property
  }
  return 40
}

export interface Lzma2Encoded {
  data: Uint8Array
  compressedChunks: number
}

export const LZMA2_ENCODE_CHUNK_SIZE = ENCODE_CHUNK_SIZE

/** Largest packed size an LZMA2 chunk header can carry. */
const MAX_CHUNK_PACKED_SIZE = 0x10000

const EMPTY = new Uint8Array(0)

/**
 * Streaming LZMA2 encoder. One LZMA coder runs the length of the stream, so a
 * match can reach back the whole dictionary rather than to the head of the
 * chunk it happens to land in; only the range coder restarts at a chunk
 * boundary, which is what the format asks for. The opening chunk resets the
 * dictionary and declares the properties, and every chunk after it asks for no
 * reset at all.
 *
 * Chunks are cut at roughly `ENCODE_CHUNK_SIZE` of input. A cut lands on
 * whatever match the encoder had settled, so a chunk may overrun the target by
 * up to one match; both header fields hold that with room to spare.
 */
export class Lzma2StreamEncoder {
  private readonly encoder: LzmaStreamEncoder
  private readonly parts: Uint8Array[] = []
  private chunkStart = 0
  private started = false
  private ended = false
  /** Chunks framed so far, which for this encoder are all compressed ones. */
  chunkCount = 0

  /**
   * `dictionarySize` has to be the size the reader will be told to allocate,
   * since it is also the furthest back a match may reach.
   */
  constructor(dictionarySize: number, options: LzmaEncoderOptions = {}) {
    this.encoder = new LzmaStreamEncoder(undefined, { ...options, maxDistance: dictionarySize })
  }

  /** Feeds input and returns whichever chunks that completed. */
  push(bytes: Uint8Array, signal?: AbortSignal): Uint8Array {
    if (this.ended) throw new Error('The LZMA2 encoder is closed')
    const framed: Uint8Array[] = []
    let offset = 0
    while (offset < bytes.length) {
      throwIfCancelled(signal)
      // Feed only what the open chunk still has room for. The encoder settles
      // less than it is handed - it holds a match's worth of lookahead back -
      // so measuring the room against what it has settled, rather than against
      // what it has been fed, is what keeps a chunk near its target size.
      const room = ENCODE_CHUNK_SIZE - (this.encoder.encodedLength - this.chunkStart)
      const take = Math.min(bytes.length - offset, Math.max(1, room))
      this.parts.push(this.encoder.update(bytes.subarray(offset, offset + take), signal))
      offset += take
      if (this.encoder.encodedLength - this.chunkStart >= ENCODE_CHUNK_SIZE) {
        framed.push(this.cut(this.encoder.endChunk()))
      }
    }
    return framed.length === 0 ? EMPTY : concatBytes(framed)
  }

  /** Closes the stream: the tail chunk, then the end marker. */
  finish(signal?: AbortSignal): Uint8Array {
    if (this.ended) throw new Error('The LZMA2 encoder is closed')
    this.ended = true
    const tail = this.cut(this.encoder.final(signal))
    return concatBytes([tail, Uint8Array.of(0)])
  }

  /** Frames everything settled since the last cut as one chunk. */
  private cut(flushed: Uint8Array): Uint8Array {
    this.parts.push(flushed)
    const packed = concatBytes(this.parts)
    this.parts.length = 0
    const unpacked = this.encoder.encodedLength - this.chunkStart
    this.chunkStart = this.encoder.encodedLength
    if (unpacked === 0) return EMPTY
    if (packed.length > MAX_CHUNK_PACKED_SIZE) {
      // A chunk cut at 48 KiB leaves the header a wide margin: the worst LZMA
      // manages on random data is a few percent over. Encrypted content sits
      // closest to that edge, so the check stays in rather than being assumed.
      throw new RangeError(`LZMA2 chunk packed to ${packed.length} bytes`)
    }
    const unpackedMinusOne = unpacked - 1
    const packedMinusOne = packed.length - 1
    const header = this.started
      ? Uint8Array.of(
        0x80 | ((unpackedMinusOne >>> 16) & 0x1f),
        (unpackedMinusOne >>> 8) & 0xff,
        unpackedMinusOne & 0xff,
        (packedMinusOne >>> 8) & 0xff,
        packedMinusOne & 0xff
      )
      : Uint8Array.of(
        0xe0 | ((unpackedMinusOne >>> 16) & 0x1f),
        (unpackedMinusOne >>> 8) & 0xff,
        unpackedMinusOne & 0xff,
        (packedMinusOne >>> 8) & 0xff,
        packedMinusOne & 0xff,
        DEFAULT_LZMA_PROPERTIES
      )
    this.started = true
    this.chunkCount += 1
    return concatBytes([header, packed])
  }
}

export function encodeLzma2(input: Uint8Array, signal?: AbortSignal): Lzma2Encoded {
  // A whole buffer in hand needs no dictionary beyond its own length.
  const encoder = new Lzma2StreamEncoder(Math.max(1, input.length))
  const head = encoder.push(input, signal)
  const tail = encoder.finish(signal)
  return { data: concatBytes([head, tail]), compressedChunks: encoder.chunkCount }
}

/** What one LZMA2 control byte asks the decoder to do before its payload. */
export interface Lzma2ChunkPlan {
  kind: 'end' | 'uncompressed' | 'lzma'
  resetDictionary: boolean
  readProperties: boolean
  resetState: boolean
}

/** Reset bookkeeping carried between LZMA2 chunks. */
export interface Lzma2ChunkState {
  needsDictionaryReset: boolean
  needsProperties: boolean
  needsStateReset: boolean
}

export function initialLzma2ChunkState(): Lzma2ChunkState {
  return { needsDictionaryReset: true, needsProperties: true, needsStateReset: true }
}

/**
 * Reads one control byte and updates the reset bookkeeping, rejecting streams
 * that lean on state they never established.
 *
 * Only a dictionary-resetting uncompressed chunk (control 1) invalidates the
 * LZMA state and properties. Control 2 carries both across, which is what
 * 7-Zip emits when it drops to stored chunks partway through incompressible
 * data and then resumes with a plain 0x80 chunk. Demanding a reset after either
 * kind rejects archives that 7-Zip and liblzma both read.
 *
 * Shared by the buffered and streaming decoders so the rule cannot drift.
 */
export function planLzma2Chunk(control: number, state: Lzma2ChunkState): Lzma2ChunkPlan {
  if (control === 0) return { kind: 'end', resetDictionary: false, readProperties: false, resetState: false }

  if (control === 1 || control === 2) {
    const resetDictionary = control === 1
    if (resetDictionary) {
      state.needsDictionaryReset = false
      state.needsProperties = true
      state.needsStateReset = true
    } else if (state.needsDictionaryReset) {
      throw invalidArchive('LZMA2 stream uses the dictionary before resetting it')
    }
    return { kind: 'uncompressed', resetDictionary, readProperties: false, resetState: false }
  }

  if (control < 0x80) throw invalidArchive('Invalid LZMA2 control byte')

  const resetDictionary = control >= 0xe0
  const readProperties = control >= 0xc0
  const resetState = control >= 0xa0

  if (resetDictionary) state.needsDictionaryReset = false
  else if (state.needsDictionaryReset) {
    throw invalidArchive('LZMA2 compressed chunk appears before a dictionary reset')
  }
  if (readProperties) state.needsProperties = false
  else if (state.needsProperties) {
    throw invalidArchive('LZMA2 compressed chunk appears before coder properties')
  }
  if (resetState) state.needsStateReset = false
  else if (state.needsStateReset) {
    throw invalidArchive('LZMA2 compressed chunk appears before a state reset')
  }
  return { kind: 'lzma', resetDictionary, readProperties, resetState }
}

export function decodeLzma2(
  input: Uint8Array,
  dictionaryProperty: number,
  expectedSize?: number,
  signal?: AbortSignal
): Uint8Array {
  const dictionarySize = dictionarySizeFromProperty(dictionaryProperty)
  const decoder = new LzmaDecoder(dictionarySize)
  const output: Uint8Array[] = []
  let outputSize = 0
  let position = 0
  const state = initialLzma2ChunkState()

  const readByte = () => {
    if (position >= input.length) throw invalidArchive('Truncated LZMA2 stream')
    return input[position++]
  }
  const readBytes = (length: number) => {
    if (length < 0 || position + length > input.length) throw invalidArchive('Truncated LZMA2 chunk')
    const value = input.subarray(position, position + length)
    position += length
    return value
  }

  while (true) {
    throwIfCancelled(signal)
    const control = readByte()
    const plan = planLzma2Chunk(control, state)
    if (plan.kind === 'end') break
    if (plan.resetDictionary) decoder.resetDictionary()

    if (plan.kind === 'uncompressed') {
      const length = ((readByte() << 8) | readByte()) + 1
      const bytes = readBytes(length).slice()
      decoder.writeUncompressed(bytes)
      output.push(bytes)
      outputSize += bytes.length
      continue
    }

    const unpackedSize = (((control & 0x1f) << 16) | (readByte() << 8) | readByte()) + 1
    const packedSize = ((readByte() << 8) | readByte()) + 1
    if (plan.readProperties) decoder.setProperties(readByte())
    if (plan.resetState) decoder.resetState()

    const decoded = decoder.decodeChunk(readBytes(packedSize), unpackedSize, signal)
    output.push(decoded)
    outputSize += decoded.length
  }

  if (position !== input.length) throw invalidArchive('LZMA2 stream contains trailing bytes')
  if (expectedSize !== undefined && outputSize !== expectedSize) {
    throw invalidArchive(`LZMA2 stream expands to ${outputSize} bytes instead of ${expectedSize}`)
  }
  return concatBytes(output)
}
