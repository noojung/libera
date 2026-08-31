import { invalidArchive, throwIfCancelled } from './errors.js'

// Wire constants and state transitions follow the public-domain LZMA SDK.
// This implementation is TypeScript-native and uses no native or WASM codec.

const BIT_MODEL_TOTAL = 1 << 11
const MOVE_BITS = 5
const TOP_VALUE = 1 << 24
const NUM_STATES = 12
const MATCH_MIN_LEN = 2
const NUM_POS_SLOT_BITS = 6
const START_POS_MODEL_INDEX = 4
const END_POS_MODEL_INDEX = 14
const NUM_FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1)
const NUM_ALIGN_BITS = 4
const ALIGN_TABLE_SIZE = 1 << NUM_ALIGN_BITS
const LEN_LOW_BITS = 3
const LEN_MID_BITS = 3
const LEN_HIGH_BITS = 8
const LEN_LOW_SYMBOLS = 1 << LEN_LOW_BITS
const LEN_MID_SYMBOLS = 1 << LEN_MID_BITS
const LEN_HIGH_SYMBOLS = 1 << LEN_HIGH_BITS

function initializedProbabilities(length: number): Uint16Array {
  const result = new Uint16Array(length)
  result.fill(BIT_MODEL_TOTAL >>> 1)
  return result
}

/**
 * Bytes a single LZMA symbol can consume in the worst case: one per bit the
 * range coder reads, and the longest symbol is a match with its full distance
 * footer. A decoder that holds this much back can always finish the symbol it
 * starts, which is what lets it suspend on a chunk boundary without unwinding
 * the probability models it has already advanced.
 */
const REQUIRED_INPUT_MAX = 96

class RangeDecoder {
  private range = 0xffffffff
  private code = 0
  private offset = 0
  private input: Uint8Array
  private length: number
  private started = false

  /** Given a buffer, the whole stream is present; otherwise it is fed in. */
  constructor(input?: Uint8Array) {
    this.input = input ?? new Uint8Array(1 << 16)
    this.length = input?.length ?? 0
    // A whole stream that cannot even start its prefix is malformed; a fed
    // stream is simply not there yet.
    if (input && !this.begin()) throw invalidArchive('Invalid LZMA range-coder prefix')
  }

  get available(): number {
    return this.length - this.offset
  }

  /** Appends more of the stream, dropping whatever has been consumed. */
  feed(bytes: Uint8Array): void {
    if (this.offset > 0) {
      this.input.copyWithin(0, this.offset, this.length)
      this.length -= this.offset
      this.offset = 0
    }
    if (this.length + bytes.length > this.input.length) {
      let size = Math.max(this.input.length, 1 << 16)
      while (size < this.length + bytes.length) size *= 2
      const grown = new Uint8Array(size)
      grown.set(this.input.subarray(0, this.length))
      this.input = grown
    }
    this.input.set(bytes, this.length)
    this.length += bytes.length
  }

  /** Reads the five byte prefix. Returns false while it has yet to arrive. */
  begin(): boolean {
    if (this.started) return true
    if (this.available < 5) return false
    if (this.input[this.offset] !== 0) throw invalidArchive('Invalid LZMA range-coder prefix')
    for (let index = 0; index < 5; index += 1) {
      this.code = ((this.code * 256) + this.input[this.offset + index]) >>> 0
    }
    this.offset += 5
    this.started = true
    return true
  }

  private normalize(): void {
    if (this.range >= TOP_VALUE) return
    if (this.offset >= this.length) throw invalidArchive('Truncated LZMA range-coded stream')
    this.range = (this.range * 256) >>> 0
    this.code = ((this.code * 256) + this.input[this.offset++]) >>> 0
  }

  bit(probabilities: Uint16Array, index: number): number {
    const probability = probabilities[index]
    const bound = Math.floor(this.range / BIT_MODEL_TOTAL) * probability
    let bit: number
    if (this.code < bound) {
      this.range = bound >>> 0
      probabilities[index] = probability + ((BIT_MODEL_TOTAL - probability) >>> MOVE_BITS)
      bit = 0
    } else {
      this.range = (this.range - bound) >>> 0
      this.code = (this.code - bound) >>> 0
      probabilities[index] = probability - (probability >>> MOVE_BITS)
      bit = 1
    }
    this.normalize()
    return bit
  }

  directBits(count: number): number {
    let result = 0
    for (let index = count; index > 0; index -= 1) {
      this.range >>>= 1
      let bit = 0
      if (this.code >= this.range) {
        this.code = (this.code - this.range) >>> 0
        bit = 1
      }
      if (this.range < TOP_VALUE) this.normalize()
      result = (result * 2) + bit
    }
    return result >>> 0
  }
}

class RangeEncoder {
  private low = 0n
  private range = 0xffffffff
  private cache = 0
  private cacheSize = 1
  // Bytes leave here as soon as they are final: the carry in `shiftLow` only
  // ever reaches the byte still held in `cache`, never one already emitted.
  // That is what lets a caller drain the encoder mid-stream.
  private output = new Uint8Array(1 << 16)
  private length = 0

  private emit(byte: number): void {
    if (this.length === this.output.length) {
      const grown = new Uint8Array(this.output.length * 2)
      grown.set(this.output)
      this.output = grown
    }
    this.output[this.length] = byte
    this.length += 1
  }

  /** Hands back the bytes settled so far and forgets them. */
  drain(): Uint8Array {
    const drained = this.output.slice(0, this.length)
    this.length = 0
    return drained
  }

  bit(probabilities: Uint16Array, index: number, bit: number): void {
    const probability = probabilities[index]
    const bound = Math.floor(this.range / BIT_MODEL_TOTAL) * probability
    if (bit === 0) {
      this.range = bound >>> 0
      probabilities[index] = probability + ((BIT_MODEL_TOTAL - probability) >>> MOVE_BITS)
    } else {
      this.low += BigInt(bound)
      this.range = (this.range - bound) >>> 0
      probabilities[index] = probability - (probability >>> MOVE_BITS)
    }
    if (this.range < TOP_VALUE) {
      this.range = (this.range * 256) >>> 0
      this.shiftLow()
    }
  }

  directBits(value: number, count: number): void {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.range >>>= 1
      if (((value >>> index) & 1) !== 0) this.low += BigInt(this.range)
      if (this.range < TOP_VALUE) {
        this.range = (this.range * 256) >>> 0
        this.shiftLow()
      }
    }
  }

  private shiftLow(): void {
    const low32 = Number(this.low & 0xffffffffn) >>> 0
    const carry = Number(this.low >> 32n)
    if (low32 < 0xff000000 || carry !== 0) {
      let cached = this.cache
      do {
        this.emit((cached + carry) & 0xff)
        cached = 0xff
        this.cacheSize -= 1
      } while (this.cacheSize !== 0)
      this.cache = low32 >>> 24
    }
    this.cacheSize += 1
    this.low = BigInt((low32 << 8) >>> 0)
  }

  finish(): Uint8Array {
    for (let index = 0; index < 5; index += 1) this.shiftLow()
    return this.drain()
  }
}

function bitTreeEncode(
  encoder: RangeEncoder,
  probabilities: Uint16Array,
  start: number,
  bits: number,
  value: number
): void {
  let symbol = 1
  for (let bitIndex = bits - 1; bitIndex >= 0; bitIndex -= 1) {
    const bit = (value >>> bitIndex) & 1
    encoder.bit(probabilities, start + symbol, bit)
    symbol = (symbol << 1) | bit
  }
}

function reverseBitTreeEncode(
  encoder: RangeEncoder,
  probabilities: Uint16Array,
  start: number,
  bits: number,
  value: number
): void {
  let symbol = 1
  for (let bitIndex = 0; bitIndex < bits; bitIndex += 1) {
    const bit = (value >>> bitIndex) & 1
    encoder.bit(probabilities, start + symbol, bit)
    symbol = (symbol << 1) | bit
  }
}

function bitTreeDecode(decoder: RangeDecoder, probabilities: Uint16Array, start: number, bits: number): number {
  let symbol = 1
  for (let index = 0; index < bits; index += 1) {
    symbol = (symbol << 1) | decoder.bit(probabilities, start + symbol)
  }
  return symbol - (1 << bits)
}

function reverseBitTreeDecode(
  decoder: RangeDecoder,
  probabilities: Uint16Array,
  start: number,
  bits: number
): number {
  let symbol = 1
  let result = 0
  for (let index = 0; index < bits; index += 1) {
    const bit = decoder.bit(probabilities, start + symbol)
    symbol = (symbol << 1) | bit
    result |= bit << index
  }
  return result >>> 0
}

class LengthDecoder {
  private readonly choice = initializedProbabilities(2)
  private readonly low: Uint16Array
  private readonly mid: Uint16Array
  private readonly high = initializedProbabilities(LEN_HIGH_SYMBOLS)

  constructor(private readonly posStates: number) {
    this.low = initializedProbabilities(posStates * LEN_LOW_SYMBOLS)
    this.mid = initializedProbabilities(posStates * LEN_MID_SYMBOLS)
  }

  decode(decoder: RangeDecoder, posState: number): number {
    if (decoder.bit(this.choice, 0) === 0) {
      return bitTreeDecode(decoder, this.low, posState << LEN_LOW_BITS, LEN_LOW_BITS)
    }
    if (decoder.bit(this.choice, 1) === 0) {
      return LEN_LOW_SYMBOLS + bitTreeDecode(decoder, this.mid, posState << LEN_MID_BITS, LEN_MID_BITS)
    }
    return LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + bitTreeDecode(decoder, this.high, 0, LEN_HIGH_BITS)
  }
}

class LengthEncoder {
  private readonly choice = initializedProbabilities(2)
  private readonly low: Uint16Array
  private readonly mid: Uint16Array
  private readonly high = initializedProbabilities(LEN_HIGH_SYMBOLS)

  constructor(private readonly posStates: number) {
    this.low = initializedProbabilities(posStates * LEN_LOW_SYMBOLS)
    this.mid = initializedProbabilities(posStates * LEN_MID_SYMBOLS)
  }

  encode(encoder: RangeEncoder, posState: number, value: number): void {
    if (value < LEN_LOW_SYMBOLS) {
      encoder.bit(this.choice, 0, 0)
      bitTreeEncode(encoder, this.low, posState << LEN_LOW_BITS, LEN_LOW_BITS, value)
      return
    }
    encoder.bit(this.choice, 0, 1)
    if (value < LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS) {
      encoder.bit(this.choice, 1, 0)
      bitTreeEncode(encoder, this.mid, posState << LEN_MID_BITS, LEN_MID_BITS, value - LEN_LOW_SYMBOLS)
      return
    }
    encoder.bit(this.choice, 1, 1)
    bitTreeEncode(
      encoder,
      this.high,
      0,
      LEN_HIGH_BITS,
      value - LEN_LOW_SYMBOLS - LEN_MID_SYMBOLS
    )
  }
}

export interface LzmaProperties {
  lc: number
  lp: number
  pb: number
}

export function parseLzmaProperties(value: number): LzmaProperties {
  if (!Number.isInteger(value) || value < 0 || value >= 9 * 5 * 5) {
    throw invalidArchive('Invalid LZMA properties')
  }
  const lc = value % 9
  const remainder = Math.floor(value / 9)
  const lp = remainder % 5
  const pb = Math.floor(remainder / 5)
  if (lc + lp > 4) throw invalidArchive('Unsupported LZMA literal context properties')
  return { lc, lp, pb }
}

/**
 * Stateful raw-LZMA decoder used by LZMA2. Probability and dictionary resets
 * are deliberately separate because LZMA2's control byte resets them
 * independently.
 */
export class LzmaDecoder {
  private dictionary: Uint8Array
  private dictionaryPosition = 0
  private dictionaryFull = 0
  private processedPosition = 0
  private previousByte = 0
  // Bytes of a match still to be copied. A match may run past the end of the
  // buffer it is being decoded into, and the copy resumes on the next call
  // rather than the symbol being decoded twice.
  private pendingLength = 0

  private properties: LzmaProperties = { lc: 3, lp: 0, pb: 2 }
  private literal = initializedProbabilities(0x300 << 3)
  private isMatch = initializedProbabilities(NUM_STATES << 4)
  private isRep = initializedProbabilities(NUM_STATES)
  private isRepG0 = initializedProbabilities(NUM_STATES)
  private isRepG1 = initializedProbabilities(NUM_STATES)
  private isRepG2 = initializedProbabilities(NUM_STATES)
  private isRep0Long = initializedProbabilities(NUM_STATES << 4)
  private posSlot = initializedProbabilities(4 << NUM_POS_SLOT_BITS)
  private posDecoders = initializedProbabilities(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
  private posAlign = initializedProbabilities(ALIGN_TABLE_SIZE)
  private lenDecoder = new LengthDecoder(16)
  private repLenDecoder = new LengthDecoder(16)
  private state = 0
  private rep0 = 0
  private rep1 = 0
  private rep2 = 0
  private rep3 = 0

  constructor(dictionarySize: number) {
    if (!Number.isSafeInteger(dictionarySize) || dictionarySize < 4096) {
      throw invalidArchive('Invalid LZMA2 dictionary size')
    }
    this.dictionary = new Uint8Array(dictionarySize)
    this.resetState()
  }

  resetDictionary(): void {
    this.dictionaryPosition = 0
    this.dictionaryFull = 0
    this.processedPosition = 0
    this.previousByte = 0
  }

  setProperties(value: number): void {
    this.properties = parseLzmaProperties(value)
    this.literal = initializedProbabilities(0x300 << (this.properties.lc + this.properties.lp))
  }

  resetState(): void {
    const posStates = 1 << this.properties.pb
    this.isMatch = initializedProbabilities(NUM_STATES * posStates)
    this.isRep = initializedProbabilities(NUM_STATES)
    this.isRepG0 = initializedProbabilities(NUM_STATES)
    this.isRepG1 = initializedProbabilities(NUM_STATES)
    this.isRepG2 = initializedProbabilities(NUM_STATES)
    this.isRep0Long = initializedProbabilities(NUM_STATES * posStates)
    this.posSlot = initializedProbabilities(4 << NUM_POS_SLOT_BITS)
    this.posDecoders = initializedProbabilities(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
    this.posAlign = initializedProbabilities(ALIGN_TABLE_SIZE)
    this.lenDecoder = new LengthDecoder(posStates)
    this.repLenDecoder = new LengthDecoder(posStates)
    this.literal.fill(BIT_MODEL_TOTAL >>> 1)
    this.state = 0
    this.rep0 = 0
    this.rep1 = 0
    this.rep2 = 0
    this.rep3 = 0
  }

  writeUncompressed(bytes: Uint8Array): void {
    for (const byte of bytes) this.putByte(byte)
  }

  private putByte(byte: number): void {
    this.dictionary[this.dictionaryPosition] = byte
    this.dictionaryPosition += 1
    if (this.dictionaryPosition === this.dictionary.length) this.dictionaryPosition = 0
    if (this.dictionaryFull < this.dictionary.length) this.dictionaryFull += 1
    this.processedPosition = (this.processedPosition + 1) >>> 0
    this.previousByte = byte
  }

  private dictionaryByte(distance: number): number {
    if (distance < 0 || distance >= this.dictionaryFull) throw invalidArchive('LZMA match exceeds dictionary history')
    let position = this.dictionaryPosition - distance - 1
    if (position < 0) position += this.dictionary.length
    return this.dictionary[position]
  }

  decodeChunk(input: Uint8Array, outputSize: number, signal?: AbortSignal): Uint8Array {
    const output = new Uint8Array(outputSize)
    this.decodeInto(new RangeDecoder(input), output, 0, outputSize, false, outputSize, signal)
    return output
  }

  /**
   * Decodes into `output` between `start` and `end`. When `suspendable` is set
   * it stops as soon as the range coder is short of a symbol's worth of input
   * rather than reading off the end, and the caller resumes it once more of
   * the stream has arrived. `allowed` is how much output the stream itself has
   * left, which is what a match is measured against - `end` only says how far
   * this buffer reaches. Returns the position it reached.
   */
  decodeInto(
    decoder: RangeDecoder,
    output: Uint8Array,
    start: number,
    end: number,
    suspendable: boolean,
    allowed: number,
    signal?: AbortSignal
  ): number {
    const { lc, lp, pb } = this.properties
    const posMask = (1 << pb) - 1
    const literalPosMask = (1 << lp) - 1
    let outputPosition = start

    while (outputPosition < end) {
      if ((outputPosition & 0x3fff) === 0) throwIfCancelled(signal)
      if (this.pendingLength > 0) {
        outputPosition = this.copyMatch(output, outputPosition, end)
        if (this.pendingLength > 0) break
        continue
      }
      // Stop on a symbol boundary: past this point the models have moved on
      // and there is no way back to the start of the symbol.
      if (suspendable && decoder.available < REQUIRED_INPUT_MAX) break
      const posState = this.processedPosition & posMask
      if (decoder.bit(this.isMatch, (this.state << pb) + posState) === 0) {
        const context = ((this.processedPosition & literalPosMask) << lc) + (this.previousByte >>> (8 - lc))
        const base = context * 0x300
        let symbol = 1
        if (this.state >= 7) {
          let matchByte = this.dictionaryByte(this.rep0)
          do {
            const matchBit = (matchByte >>> 7) & 1
            matchByte = (matchByte << 1) & 0xff
            const bit = decoder.bit(this.literal, base + 0x100 + (matchBit << 8) + symbol)
            symbol = (symbol << 1) | bit
            if (matchBit !== bit) {
              while (symbol < 0x100) symbol = (symbol << 1) | decoder.bit(this.literal, base + symbol)
              break
            }
          } while (symbol < 0x100)
        } else {
          while (symbol < 0x100) symbol = (symbol << 1) | decoder.bit(this.literal, base + symbol)
        }

        const byte = symbol - 0x100
        output[outputPosition++] = byte
        this.putByte(byte)
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6
        continue
      }

      let length: number
      if (decoder.bit(this.isRep, this.state) === 1) {
        if (decoder.bit(this.isRepG0, this.state) === 0) {
          if (decoder.bit(this.isRep0Long, (this.state << pb) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11
            const byte = this.dictionaryByte(this.rep0)
            output[outputPosition++] = byte
            this.putByte(byte)
            continue
          }
        } else {
          let distance: number
          if (decoder.bit(this.isRepG1, this.state) === 0) {
            distance = this.rep1
          } else {
            if (decoder.bit(this.isRepG2, this.state) === 0) {
              distance = this.rep2
            } else {
              distance = this.rep3
              this.rep3 = this.rep2
            }
            this.rep2 = this.rep1
          }
          this.rep1 = this.rep0
          this.rep0 = distance
        }
        length = this.repLenDecoder.decode(decoder, posState) + MATCH_MIN_LEN
        this.state = this.state < 7 ? 8 : 11
      } else {
        this.rep3 = this.rep2
        this.rep2 = this.rep1
        this.rep1 = this.rep0
        length = this.lenDecoder.decode(decoder, posState) + MATCH_MIN_LEN
        this.state = this.state < 7 ? 7 : 10

        const lenState = Math.min(length - MATCH_MIN_LEN, 3)
        const posSlot = bitTreeDecode(decoder, this.posSlot, lenState << NUM_POS_SLOT_BITS, NUM_POS_SLOT_BITS)
        if (posSlot < START_POS_MODEL_INDEX) {
          this.rep0 = posSlot
        } else {
          const directBits = (posSlot >>> 1) - 1
          this.rep0 = ((2 | (posSlot & 1)) << directBits) >>> 0
          if (posSlot < END_POS_MODEL_INDEX) {
            this.rep0 = (this.rep0 + reverseBitTreeDecode(
              decoder,
              this.posDecoders,
              this.rep0 - posSlot - 1,
              directBits
            )) >>> 0
          } else {
            this.rep0 = (this.rep0 + (decoder.directBits(directBits - NUM_ALIGN_BITS) << NUM_ALIGN_BITS)) >>> 0
            this.rep0 = (this.rep0 + reverseBitTreeDecode(decoder, this.posAlign, 0, NUM_ALIGN_BITS)) >>> 0
            if (this.rep0 === 0xffffffff) throw invalidArchive('Unexpected LZMA end marker inside LZMA2 chunk')
          }
        }
      }

      if (length > allowed - (outputPosition - start)) {
        throw invalidArchive('LZMA match exceeds declared chunk size')
      }
      this.pendingLength = length
      outputPosition = this.copyMatch(output, outputPosition, end)
      if (this.pendingLength > 0) break
    }

    return outputPosition
  }

  /** Copies as much of the outstanding match as the buffer has room for. */
  private copyMatch(output: Uint8Array, outputPosition: number, end: number): number {
    let position = outputPosition
    while (this.pendingLength > 0 && position < end) {
      const byte = this.dictionaryByte(this.rep0)
      output[position] = byte
      position += 1
      this.putByte(byte)
      this.pendingLength -= 1
    }
    return position
  }
}

/** How much output the streaming decoder produces per pull. */
const DECODE_OUTPUT_CHUNK = 256 * 1024

/**
 * Streaming raw LZMA decoder. The dictionary was already circular, so only the
 * ends were one-shot: this feeds the range coder in pieces and yields output a
 * slice at a time, which keeps the memory to the dictionary rather than to the
 * size of the entry.
 *
 * It is pull-driven on purpose. A little input can decode to a great deal of
 * output, so the caller asks for one slice at a time and can let its consumer
 * catch up in between rather than holding the whole entry.
 *
 * The stream must declare how many bytes it decodes to, the way ZIP's method
 * 14 entries do; there is no end-of-stream marker to stop on.
 */
export class LzmaStreamDecoder {
  private readonly decoder: LzmaDecoder
  private readonly range = new RangeDecoder()
  private readonly buffer = new Uint8Array(DECODE_OUTPUT_CHUNK)
  private remaining: number
  private ended = false

  constructor(dictionarySize: number, propertyByte: number, outputSize: number) {
    if (!Number.isSafeInteger(outputSize) || outputSize < 0) {
      throw invalidArchive('Invalid LZMA output size')
    }
    this.decoder = new LzmaDecoder(dictionarySize)
    this.decoder.resetDictionary()
    this.decoder.setProperties(propertyByte)
    this.decoder.resetState()
    this.remaining = outputSize
  }

  /** How much output the stream has still to produce. */
  get pending(): number {
    return this.remaining
  }

  /** Hands more of the compressed stream to the decoder. */
  push(chunk: Uint8Array): void {
    if (this.ended) throw new Error('The LZMA decoder is closed')
    this.range.feed(chunk)
  }

  /**
   * Marks the compressed stream complete, after which the decoder no longer
   * holds a symbol's worth of input back.
   */
  end(): void {
    this.ended = true
  }

  /**
   * Decodes the next slice of output, or nothing when it needs more input.
   * Call it until it returns nothing, then push more and call again.
   */
  pull(signal?: AbortSignal): Uint8Array | undefined {
    if (this.remaining === 0) return undefined
    if (!this.range.begin()) return undefined
    const target = Math.min(this.buffer.length, this.remaining)
    const produced = this.decoder.decodeInto(
      this.range, this.buffer, 0, target, !this.ended, this.remaining, signal
    )
    if (produced === 0) return undefined
    this.remaining -= produced
    return this.buffer.slice(0, produced)
  }

  /** Fails when the stream ran out before producing everything it declared. */
  assertComplete(): void {
    if (this.remaining > 0) throw invalidArchive('Truncated LZMA range-coded stream')
  }
}

export interface LzmaEncoderOptions {
  searchDepth?: number
  niceLength?: number
  /**
   * Largest match distance the encoder may emit. Callers that must declare a
   * dictionary size up front - ZIP's method 14 header, for one - set this so
   * the stream never reaches back further than the decoder will allocate.
   * Unset lets a match reach the start of the input.
   */
  maxDistance?: number
}

function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

function hash3(input: Uint8Array, position: number): number {
  return (((input[position] * 251) ^ (input[position + 1] * 31) ^ input[position + 2]) & 0xffff) >>> 0
}

/** Longest match LZMA can encode, and so the lookahead a match needs. */
const MATCH_MAX_LEN = 273

/**
 * Streaming raw LZMA encoder. A bounded hash chain supplies matches; LZMA's
 * adaptive literal, length, distance and repeated-distance models then produce
 * the same range-coded wire format as the SDK implementation.
 *
 * Only the last `maxDistance` bytes are held, so the memory an entry needs is
 * set by the dictionary rather than by the size of the entry. Data arrives
 * through `update` and the stream is closed with `final`; both hand back the
 * bytes settled so far.
 */
export class LzmaStreamEncoder {
  private readonly posStates: number
  private readonly isMatch: Uint16Array
  private readonly isRep: Uint16Array
  private readonly isRepG0: Uint16Array
  private readonly isRepG1: Uint16Array
  private readonly isRepG2: Uint16Array
  private readonly isRep0Long: Uint16Array
  private readonly literals: Uint16Array
  private readonly posSlot: Uint16Array
  private readonly posDecoders: Uint16Array
  private readonly posAlign: Uint16Array
  private readonly lenEncoder: LengthEncoder
  private readonly repLenEncoder: LengthEncoder
  private readonly encoder = new RangeEncoder()
  private readonly literalPosMask: number
  private readonly searchDepth: number
  private readonly niceLength: number
  private readonly maxDistance: number

  // The match finder. `head` holds the newest position per hash and `previous`
  // chains older ones; both store absolute positions, and `previous` is a ring
  // the size of the window, since the walk stops before reaching a slot old
  // enough to have been overwritten.
  private readonly windowMask: number
  private readonly head = new Int32Array(1 << 16)
  private readonly previous: Int32Array

  // `window` holds the bytes still in reach. It keeps `keep` bytes of history
  // behind the encode position plus room to read ahead; when it fills, the
  // history is moved to the front and `base` follows.
  private readonly keep: number
  private window: Uint8Array
  private base = 0
  private fill = 0

  private position = 0
  private previousByte = 0
  private state = 0
  private rep0 = 0
  private rep1 = 0
  private rep2 = 0
  private rep3 = 0
  private closed = false

  constructor(
    private readonly properties: LzmaProperties = { lc: 3, lp: 0, pb: 2 },
    options: LzmaEncoderOptions = {}
  ) {
    this.posStates = 1 << properties.pb
    this.isMatch = initializedProbabilities(NUM_STATES * this.posStates)
    this.isRep = initializedProbabilities(NUM_STATES)
    this.isRepG0 = initializedProbabilities(NUM_STATES)
    this.isRepG1 = initializedProbabilities(NUM_STATES)
    this.isRepG2 = initializedProbabilities(NUM_STATES)
    this.isRep0Long = initializedProbabilities(NUM_STATES * this.posStates)
    this.literals = initializedProbabilities(0x300 << (properties.lc + properties.lp))
    this.posSlot = initializedProbabilities(4 << NUM_POS_SLOT_BITS)
    this.posDecoders = initializedProbabilities(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
    this.posAlign = initializedProbabilities(ALIGN_TABLE_SIZE)
    this.lenEncoder = new LengthEncoder(this.posStates)
    this.repLenEncoder = new LengthEncoder(this.posStates)
    this.literalPosMask = (1 << properties.lp) - 1
    this.searchDepth = Math.max(1, Math.min(1024, options.searchDepth ?? 32))
    this.niceLength = Math.max(3, Math.min(273, options.niceLength ?? 64))
    this.maxDistance = Math.max(1, options.maxDistance ?? 1 << 24)

    this.keep = nextPowerOfTwo(this.maxDistance)
    this.windowMask = this.keep - 1
    this.previous = new Int32Array(this.keep)
    this.previous.fill(-1)
    this.head.fill(-1)
    // Room for the history plus a stretch to read ahead in. The lookahead has
    // to clear one whole match for the encoder to make progress at all.
    this.window = new Uint8Array(this.keep + Math.max(this.keep, 8 * MATCH_MAX_LEN))
  }

  /** Feeds more input and returns whatever the encoder could settle. */
  update(chunk: Uint8Array, signal?: AbortSignal): Uint8Array {
    if (this.closed) throw new Error('The LZMA encoder is closed')
    let offset = 0
    while (offset < chunk.length) {
      const room = this.window.length - this.fill
      if (room === 0) {
        this.slideWindow()
        continue
      }
      const take = Math.min(room, chunk.length - offset)
      this.window.set(chunk.subarray(offset, offset + take), this.fill)
      this.fill += take
      offset += take
      // Stop short of the end: a match that runs to the edge of what has
      // arrived might have run further with the next chunk in hand. The extra
      // byte of margin keeps the hash inserts that trail a longest match from
      // running out of input too, which would leave the chain a slot short of
      // what encoding the whole buffer at once would have recorded.
      this.encodeUntil(this.base + this.fill - (MATCH_MAX_LEN + 1), signal)
    }
    return this.encoder.drain()
  }

  /** Closes the stream: encodes the tail and flushes the range coder. */
  final(signal?: AbortSignal): Uint8Array {
    if (this.closed) throw new Error('The LZMA encoder is closed')
    this.encodeUntil(this.base + this.fill, signal)
    this.closed = true
    return this.encoder.finish()
  }

  /** Drops the history that has fallen out of reach and rebases the window. */
  private slideWindow(): void {
    const retained = Math.min(this.keep, this.position - this.base)
    const discarded = this.position - retained - this.base
    if (discarded <= 0) throw new Error('The LZMA window is too small to advance')
    this.window.copyWithin(0, discarded, this.fill)
    this.base += discarded
    this.fill -= discarded
  }

  private insert(position: number, end: number): void {
    if (position + 2 >= end) return
    const offset = position - this.base
    const hash = hash3(this.window, offset)
    this.previous[position & this.windowMask] = this.head[hash]
    this.head[hash] = position
  }

  private encodeUntil(limit: number, signal?: AbortSignal): void {
    const window = this.window
    const end = this.base + this.fill
    const { properties } = this

    while (this.position < limit) {
      throwIfCancelled(signal)
      const position = this.position
      const offset = position - this.base
      const available = end - position
      let bestLength = 0
      let bestDistance = 0

      if (available > 2) {
        let candidate = this.head[hash3(window, offset)]
        let searched = 0
        const maxLength = Math.min(MATCH_MAX_LEN, available)
        while (candidate >= 0 && searched < this.searchDepth) {
          const distance = position - candidate
          // Candidates come newest first, so the first one out of reach ends it.
          if (distance > this.maxDistance) break
          const candidateOffset = offset - distance
          if (distance > 0 && window[candidateOffset + bestLength] === window[offset + bestLength]) {
            let length = 0
            while (length < maxLength && window[candidateOffset + length] === window[offset + length]) length += 1
            if (length > bestLength) {
              bestLength = length
              bestDistance = distance - 1
              if (length >= this.niceLength) break
            }
          }
          // Safe against the ring wrapping: a slot is only overwritten once the
          // position is further back than `maxDistance`, and the break above
          // stops the walk before it reaches one.
          candidate = this.previous[candidate & this.windowMask]
          searched += 1
        }
      }

      const posState = position & (this.posStates - 1)
      if (bestLength < 3) {
        this.encoder.bit(this.isMatch, (this.state << properties.pb) + posState, 0)
        const context = ((position & this.literalPosMask) << properties.lc) +
          (this.previousByte >>> (8 - properties.lc))
        const base = context * 0x300
        let symbol = 1
        const byte = window[offset]
        let matched = this.state >= 7
        let matchByte = matched ? window[offset - this.rep0 - 1] : 0
        for (let bitIndex = 7; bitIndex >= 0; bitIndex -= 1) {
          const bit = (byte >>> bitIndex) & 1
          if (matched) {
            const matchBit = (matchByte >>> 7) & 1
            matchByte = (matchByte << 1) & 0xff
            this.encoder.bit(this.literals, base + 0x100 + (matchBit << 8) + symbol, bit)
            if (matchBit !== bit) matched = false
          } else {
            this.encoder.bit(this.literals, base + symbol, bit)
          }
          symbol = (symbol << 1) | bit
        }
        this.insert(position, end)
        this.previousByte = byte
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6
        this.position = position + 1
        continue
      }

      this.encoder.bit(this.isMatch, (this.state << properties.pb) + posState, 1)
      const reps = [this.rep0, this.rep1, this.rep2, this.rep3]
      const repIndex = reps.indexOf(bestDistance)
      if (repIndex >= 0) {
        this.encoder.bit(this.isRep, this.state, 1)
        if (repIndex === 0) {
          this.encoder.bit(this.isRepG0, this.state, 0)
          this.encoder.bit(this.isRep0Long, (this.state << properties.pb) + posState, 1)
        } else {
          this.encoder.bit(this.isRepG0, this.state, 1)
          if (repIndex === 1) {
            this.encoder.bit(this.isRepG1, this.state, 0)
          } else {
            this.encoder.bit(this.isRepG1, this.state, 1)
            this.encoder.bit(this.isRepG2, this.state, repIndex === 2 ? 0 : 1)
          }
          if (repIndex === 1) {
            this.rep1 = this.rep0
          } else if (repIndex === 2) {
            this.rep2 = this.rep1
            this.rep1 = this.rep0
          } else {
            this.rep3 = this.rep2
            this.rep2 = this.rep1
            this.rep1 = this.rep0
          }
          this.rep0 = bestDistance
        }
        this.repLenEncoder.encode(this.encoder, posState, bestLength - MATCH_MIN_LEN)
        this.state = this.state < 7 ? 8 : 11
      } else {
        this.encoder.bit(this.isRep, this.state, 0)
        this.state = this.state < 7 ? 7 : 10
        this.lenEncoder.encode(this.encoder, posState, bestLength - MATCH_MIN_LEN)
        this.rep3 = this.rep2
        this.rep2 = this.rep1
        this.rep1 = this.rep0
        this.rep0 = bestDistance

        const lenState = Math.min(bestLength - MATCH_MIN_LEN, 3)
        let distanceSlot: number
        if (bestDistance < START_POS_MODEL_INDEX) {
          distanceSlot = bestDistance
        } else {
          const log = Math.floor(Math.log2(bestDistance))
          distanceSlot = (log << 1) + ((bestDistance >>> (log - 1)) & 1)
        }
        bitTreeEncode(this.encoder, this.posSlot, lenState << NUM_POS_SLOT_BITS, NUM_POS_SLOT_BITS, distanceSlot)
        if (distanceSlot >= START_POS_MODEL_INDEX) {
          const directBits = (distanceSlot >>> 1) - 1
          const baseDistance = (2 | (distanceSlot & 1)) << directBits
          const footer = bestDistance - baseDistance
          if (distanceSlot < END_POS_MODEL_INDEX) {
            reverseBitTreeEncode(this.encoder, this.posDecoders, baseDistance - distanceSlot - 1, directBits, footer)
          } else {
            this.encoder.directBits(footer >>> NUM_ALIGN_BITS, directBits - NUM_ALIGN_BITS)
            reverseBitTreeEncode(this.encoder, this.posAlign, 0, NUM_ALIGN_BITS, footer & (ALIGN_TABLE_SIZE - 1))
          }
        }
      }

      for (let index = 0; index < bestLength; index += 1) this.insert(position + index, end)
      this.previousByte = window[offset + bestLength - 1]
      this.position = position + bestLength
    }
  }
}

/**
 * Encodes a whole buffer in one call. The window is sized to the input unless
 * the caller caps it, so the output matches what the streaming encoder
 * produces for the same input and the same cap.
 */
export function encodeLzma(
  input: Uint8Array,
  properties: LzmaProperties = { lc: 3, lp: 0, pb: 2 },
  options: LzmaEncoderOptions = {}
): Uint8Array {
  const encoder = new LzmaStreamEncoder(properties, {
    ...options,
    maxDistance: Math.max(1, Math.min(options.maxDistance ?? input.length, Math.max(1, input.length)))
  })
  const head = encoder.update(input)
  const tail = encoder.final()
  const output = new Uint8Array(head.length + tail.length)
  output.set(head)
  output.set(tail, head.length)
  return output
}

// Kept as a source-compatible name for early callers; it now uses the full
// match encoder rather than a literal-only stream.
export const encodeLiteralLzma = encodeLzma
