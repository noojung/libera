import { invalidArchive, throwIfCancelled } from './errors'

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

class RangeDecoder {
  private range = 0xffffffff
  private code = 0
  private offset = 0

  constructor(private readonly input: Uint8Array) {
    if (input.length < 5 || input[0] !== 0) throw invalidArchive('Invalid LZMA range-coder prefix')
    for (let index = 0; index < 5; index += 1) this.code = ((this.code * 256) + input[index]) >>> 0
    this.offset = 5
  }

  private normalize(): void {
    if (this.range >= TOP_VALUE) return
    if (this.offset >= this.input.length) throw invalidArchive('Truncated LZMA range-coded stream')
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
  private readonly output: number[] = []

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
        this.output.push((cached + carry) & 0xff)
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
    return Uint8Array.from(this.output)
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
    const decoder = new RangeDecoder(input)
    const output = new Uint8Array(outputSize)
    const { lc, lp, pb } = this.properties
    const posMask = (1 << pb) - 1
    const literalPosMask = (1 << lp) - 1
    let outputPosition = 0

    while (outputPosition < output.length) {
      if ((outputPosition & 0x3fff) === 0) throwIfCancelled(signal)
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

      if (length > output.length - outputPosition) throw invalidArchive('LZMA match exceeds declared chunk size')
      for (let index = 0; index < length; index += 1) {
        const byte = this.dictionaryByte(this.rep0)
        output[outputPosition++] = byte
        this.putByte(byte)
      }
    }

    return output
  }
}

export interface LzmaEncoderOptions {
  searchDepth?: number
  niceLength?: number
}

function hash3(input: Uint8Array, position: number): number {
  return (((input[position] * 251) ^ (input[position + 1] * 31) ^ input[position + 2]) & 0xffff) >>> 0
}

/**
 * Pure-JavaScript raw LZMA encoder. A bounded hash chain supplies matches;
 * LZMA's adaptive literal, length, distance and repeated-distance models then
 * produce the same range-coded wire format as the SDK implementation.
 */
export function encodeLzma(
  input: Uint8Array,
  properties: LzmaProperties = { lc: 3, lp: 0, pb: 2 },
  options: LzmaEncoderOptions = {}
): Uint8Array {
  const posStates = 1 << properties.pb
  const isMatch = initializedProbabilities(NUM_STATES * posStates)
  const isRep = initializedProbabilities(NUM_STATES)
  const isRepG0 = initializedProbabilities(NUM_STATES)
  const isRepG1 = initializedProbabilities(NUM_STATES)
  const isRepG2 = initializedProbabilities(NUM_STATES)
  const isRep0Long = initializedProbabilities(NUM_STATES * posStates)
  const literals = initializedProbabilities(0x300 << (properties.lc + properties.lp))
  const posSlot = initializedProbabilities(4 << NUM_POS_SLOT_BITS)
  const posDecoders = initializedProbabilities(NUM_FULL_DISTANCES - END_POS_MODEL_INDEX)
  const posAlign = initializedProbabilities(ALIGN_TABLE_SIZE)
  const lenEncoder = new LengthEncoder(posStates)
  const repLenEncoder = new LengthEncoder(posStates)
  const encoder = new RangeEncoder()
  const literalPosMask = (1 << properties.lp) - 1
  const head = new Int32Array(1 << 16)
  const previous = new Int32Array(input.length)
  head.fill(-1)
  previous.fill(-1)
  const searchDepth = Math.max(1, Math.min(1024, options.searchDepth ?? 32))
  const niceLength = Math.max(3, Math.min(273, options.niceLength ?? 64))
  let previousByte = 0
  let state = 0
  let rep0 = 0
  let rep1 = 0
  let rep2 = 0
  let rep3 = 0

  const insert = (position: number) => {
    if (position + 2 >= input.length) return
    const hash = hash3(input, position)
    previous[position] = head[hash]
    head[hash] = position
  }

  let position = 0
  while (position < input.length) {
    let bestLength = 0
    let bestDistance = 0
    if (position + 2 < input.length) {
      let candidate = head[hash3(input, position)]
      let searched = 0
      const maxLength = Math.min(273, input.length - position)
      while (candidate >= 0 && searched < searchDepth) {
        const distance = position - candidate
        if (distance > 0 && input[candidate + bestLength] === input[position + bestLength]) {
          let length = 0
          while (length < maxLength && input[candidate + length] === input[position + length]) length += 1
          if (length > bestLength) {
            bestLength = length
            bestDistance = distance - 1
            if (length >= niceLength) break
          }
        }
        candidate = previous[candidate]
        searched += 1
      }
    }

    const posState = position & (posStates - 1)
    if (bestLength < 3) {
      encoder.bit(isMatch, (state << properties.pb) + posState, 0)
      const context = ((position & literalPosMask) << properties.lc) + (previousByte >>> (8 - properties.lc))
      const base = context * 0x300
      let symbol = 1
      const byte = input[position]
      let matched = state >= 7
      let matchByte = matched ? input[position - rep0 - 1] : 0
      for (let bitIndex = 7; bitIndex >= 0; bitIndex -= 1) {
        const bit = (byte >>> bitIndex) & 1
        if (matched) {
          const matchBit = (matchByte >>> 7) & 1
          matchByte = (matchByte << 1) & 0xff
          encoder.bit(literals, base + 0x100 + (matchBit << 8) + symbol, bit)
          if (matchBit !== bit) matched = false
        } else {
          encoder.bit(literals, base + symbol, bit)
        }
        symbol = (symbol << 1) | bit
      }
      insert(position)
      previousByte = byte
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
      position += 1
      continue
    }

    encoder.bit(isMatch, (state << properties.pb) + posState, 1)
    const reps = [rep0, rep1, rep2, rep3]
    const repIndex = reps.indexOf(bestDistance)
    if (repIndex >= 0) {
      encoder.bit(isRep, state, 1)
      if (repIndex === 0) {
        encoder.bit(isRepG0, state, 0)
        encoder.bit(isRep0Long, (state << properties.pb) + posState, 1)
      } else {
        encoder.bit(isRepG0, state, 1)
        if (repIndex === 1) {
          encoder.bit(isRepG1, state, 0)
        } else {
          encoder.bit(isRepG1, state, 1)
          encoder.bit(isRepG2, state, repIndex === 2 ? 0 : 1)
        }
        if (repIndex === 1) {
          rep1 = rep0
        } else if (repIndex === 2) {
          rep2 = rep1
          rep1 = rep0
        } else {
          rep3 = rep2
          rep2 = rep1
          rep1 = rep0
        }
        rep0 = bestDistance
      }
      repLenEncoder.encode(encoder, posState, bestLength - MATCH_MIN_LEN)
      state = state < 7 ? 8 : 11
    } else {
      encoder.bit(isRep, state, 0)
      state = state < 7 ? 7 : 10
      lenEncoder.encode(encoder, posState, bestLength - MATCH_MIN_LEN)
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      rep0 = bestDistance

      const lenState = Math.min(bestLength - MATCH_MIN_LEN, 3)
      let distanceSlot: number
      if (bestDistance < START_POS_MODEL_INDEX) {
        distanceSlot = bestDistance
      } else {
        const log = Math.floor(Math.log2(bestDistance))
        distanceSlot = (log << 1) + ((bestDistance >>> (log - 1)) & 1)
      }
      bitTreeEncode(encoder, posSlot, lenState << NUM_POS_SLOT_BITS, NUM_POS_SLOT_BITS, distanceSlot)
      if (distanceSlot >= START_POS_MODEL_INDEX) {
        const directBits = (distanceSlot >>> 1) - 1
        const baseDistance = (2 | (distanceSlot & 1)) << directBits
        const footer = bestDistance - baseDistance
        if (distanceSlot < END_POS_MODEL_INDEX) {
          reverseBitTreeEncode(encoder, posDecoders, baseDistance - distanceSlot - 1, directBits, footer)
        } else {
          encoder.directBits(footer >>> NUM_ALIGN_BITS, directBits - NUM_ALIGN_BITS)
          reverseBitTreeEncode(encoder, posAlign, 0, NUM_ALIGN_BITS, footer & (ALIGN_TABLE_SIZE - 1))
        }
      }
    }

    for (let index = 0; index < bestLength; index += 1) insert(position + index)
    previousByte = input[position + bestLength - 1]
    position += bestLength
  }

  return encoder.finish()
}

// Kept as a source-compatible name for early callers; it now uses the full
// match encoder rather than a literal-only stream.
export const encodeLiteralLzma = encodeLzma
