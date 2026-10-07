import { invalid, u32le, unsupported } from './bytes'
import { decodeLzvnInto } from './lzvn'

// LZFSE, the ULFO image codec and one of the filesystem compression methods.
// A stream is a run of blocks, each opened by a four-byte magic:
//
//   bvx-  stored bytes
//   bvxn  an LZVN stream, for blocks too small for the entropy coder
//   bvx2  literals and (literal length, match length, distance) triples,
//         each coded with finite state entropy (FSE)
//   bvx$  end of stream
//
// The FSE payloads are read backwards, from their last bit to their first, as
// the reference encoder writes them. This follows lzfse_decode_base.c.

const END = 0x24787662
const STORED = 0x2d787662
const V1 = 0x31787662
const V2 = 0x32787662
const LZVN = 0x6e787662

const L_SYMBOLS = 20
const M_SYMBOLS = 20
const D_SYMBOLS = 64
const LITERAL_SYMBOLS = 256
const L_STATES = 64
const M_STATES = 64
const D_STATES = 256
const LITERAL_STATES = 1024
const MATCHES_PER_BLOCK = 10000
const LITERALS_PER_BLOCK = 4 * MATCHES_PER_BLOCK

const L_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 5, 8]
const L_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 28, 60]
const M_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5, 8, 11]
const M_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 24, 56, 312]
const D_EXTRA_BITS: number[] = []
const D_BASE: number[] = []
// Distances come in groups of four symbols, each group one extra bit wider.
for (let symbol = 0, base = 0; symbol < D_SYMBOLS; symbol++) {
  D_EXTRA_BITS.push(symbol >> 2)
  D_BASE.push(base)
  base += 1 << (symbol >> 2)
}

// A frequency is written in 2 to 14 bits, chosen by its low five bits.
const FREQ_BITS = [2, 3, 2, 5, 2, 3, 2, 8, 2, 3, 2, 5, 2, 3, 2, 14, 2, 3, 2, 5, 2, 3, 2, 8, 2, 3, 2, 5, 2, 3, 2, 14]
const FREQ_VALUE = [0, 2, 1, 4, 0, 3, 1, -1, 0, 2, 1, 5, 0, 3, 1, -1, 0, 2, 1, 6, 0, 3, 1, -1, 0, 2, 1, 7, 0, 3, 1, -1]

/** Reads an FSE payload from its last bit towards its first. */
class BackwardBits {
  private remaining: number

  constructor(private readonly data: Uint8Array, private readonly start: number, end: number, initialBits: number) {
    // The final byte may hold up to seven bits of padding, which must be zero.
    if (initialBits > 0 || initialBits < -7 || end - start < (initialBits === 0 ? 7 : 8)) invalid('malformed LZFSE payload')
    this.remaining = (end - start) * 8 + initialBits
    if (initialBits < 0 && data[end - 1] >> (8 + initialBits) !== 0) invalid('malformed LZFSE payload')
  }

  pull(count: number): number {
    if (count === 0) return 0
    const low = this.remaining - count
    if (low < 0) invalid('LZFSE payload exhausted')
    this.remaining = low
    const at = this.start + (low >>> 3)
    const shift = low & 7
    const data = this.data
    // Every code is at most 25 bits, so one 32-bit window always covers it.
    const word = at + 3 < data.length
      ? (data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24) >>> 0
      : (data[at] | (data[at + 1] ?? 0) << 8 | (data[at + 2] ?? 0) << 16) >>> 0
    return (word >>> shift) & ((1 << count) - 1)
  }
}

interface LiteralTable { bits: Uint8Array; symbol: Uint8Array; delta: Int32Array }
interface ValueTable { totalBits: Uint8Array; valueBits: Uint8Array; delta: Int32Array; base: Int32Array }

function checkFrequencies(freq: Uint16Array, states: number): void {
  let sum = 0
  for (const f of freq) sum += f
  if (sum > states) invalid('LZFSE frequency table overflows its states')
}

function literalTable(freq: Uint16Array): LiteralTable {
  const table = { bits: new Uint8Array(LITERAL_STATES), symbol: new Uint8Array(LITERAL_STATES), delta: new Int32Array(LITERAL_STATES) }
  const stateClz = Math.clz32(LITERAL_STATES)
  let at = 0
  for (let symbol = 0; symbol < freq.length; symbol++) {
    const f = freq[symbol]
    if (f === 0) continue
    const k = Math.clz32(f) - stateClz
    const j0 = ((2 * LITERAL_STATES) >> k) - f
    for (let j = 0; j < f; j++, at++) {
      table.symbol[at] = symbol
      if (j < j0) {
        table.bits[at] = k
        table.delta[at] = ((f + j) << k) - LITERAL_STATES
      } else {
        table.bits[at] = k - 1
        table.delta[at] = (j - j0) << (k - 1)
      }
    }
  }
  return table
}

function valueTable(freq: Uint16Array, states: number, extraBits: number[], base: number[]): ValueTable {
  const table = {
    totalBits: new Uint8Array(states), valueBits: new Uint8Array(states),
    delta: new Int32Array(states), base: new Int32Array(states)
  }
  const stateClz = Math.clz32(states)
  let at = 0
  for (let symbol = 0; symbol < freq.length; symbol++) {
    const f = freq[symbol]
    if (f === 0) continue
    const k = Math.clz32(f) - stateClz
    const j0 = ((2 * states) >> k) - f
    for (let j = 0; j < f; j++, at++) {
      table.valueBits[at] = extraBits[symbol]
      table.base[at] = base[symbol]
      if (j < j0) {
        table.totalBits[at] = k + extraBits[symbol]
        table.delta[at] = ((f + j) << k) - states
      } else {
        table.totalBits[at] = k - 1 + extraBits[symbol]
        table.delta[at] = (j - j0) << (k - 1)
      }
    }
  }
  return table
}

function field(value: bigint, offset: number, bits: number): number {
  return Number((value >> BigInt(offset)) & ((1n << BigInt(bits)) - 1n))
}

function u64(input: Uint8Array, offset: number): bigint {
  return BigInt(u32le(input, offset + 4)) << 32n | BigInt(u32le(input, offset))
}

/** Decodes one bvx2 block at `pos`; returns the position after it and the output size. */
function decodeV2Block(input: Uint8Array, pos: number, out: Uint8Array, at: number, limit: number): [number, number] {
  const rawBytes = u32le(input, pos + 4)
  const v0 = u64(input, pos + 8)
  const v1 = u64(input, pos + 16)
  const v2 = u64(input, pos + 24)
  const literalCount = field(v0, 0, 20)
  const literalPayload = field(v0, 20, 20)
  const matchCount = field(v0, 40, 20)
  const literalBits = field(v0, 60, 3) - 7
  const literalStates = [field(v1, 0, 10), field(v1, 10, 10), field(v1, 20, 10), field(v1, 30, 10)]
  const lmdPayload = field(v1, 40, 20)
  const lmdBits = field(v1, 60, 3) - 7
  const headerSize = field(v2, 0, 32)
  let lState = field(v2, 32, 10)
  let mState = field(v2, 42, 10)
  let dState = field(v2, 52, 10)

  if (literalCount > LITERALS_PER_BLOCK || matchCount > MATCHES_PER_BLOCK ||
      literalStates.some(state => state >= LITERAL_STATES) ||
      lState >= L_STATES || mState >= M_STATES || dState >= D_STATES) {
    invalid('malformed LZFSE block header')
  }
  if (rawBytes > limit - at) invalid('LZFSE output exceeds its declared size')
  const headerEnd = pos + headerSize
  const literalEnd = headerEnd + literalPayload
  const lmdEnd = literalEnd + lmdPayload
  if (headerSize < 32 || lmdEnd > input.length) invalid('truncated LZFSE block')

  // Frequencies for L, M, D and literal symbols, packed back to back.
  const freq = new Uint16Array(L_SYMBOLS + M_SYMBOLS + D_SYMBOLS + LITERAL_SYMBOLS)
  let src = pos + 32
  let accum = 0
  let accumBits = 0
  for (let i = 0; i < freq.length; i++) {
    while (src < headerEnd && accumBits + 8 <= 32) {
      accum = (accum | input[src] << accumBits) >>> 0
      accumBits += 8
      src++
    }
    const code = accum & 31
    const bits = FREQ_BITS[code]
    if (bits > accumBits) invalid('malformed LZFSE frequency table')
    freq[i] = bits === 8 ? 8 + (accum >>> 4 & 0xf) : bits === 14 ? 24 + (accum >>> 4 & 0x3ff) : FREQ_VALUE[code]
    accum >>>= bits
    accumBits -= bits
  }
  if (accumBits >= 8 || src !== headerEnd) invalid('malformed LZFSE frequency table')
  const lFreq = freq.subarray(0, L_SYMBOLS)
  const mFreq = freq.subarray(L_SYMBOLS, L_SYMBOLS + M_SYMBOLS)
  const dFreq = freq.subarray(L_SYMBOLS + M_SYMBOLS, L_SYMBOLS + M_SYMBOLS + D_SYMBOLS)
  const literalFreq = freq.subarray(L_SYMBOLS + M_SYMBOLS + D_SYMBOLS)
  checkFrequencies(lFreq, L_STATES)
  checkFrequencies(mFreq, M_STATES)
  checkFrequencies(dFreq, D_STATES)
  checkFrequencies(literalFreq, LITERAL_STATES)

  // Literals come four at a time, from four interleaved states.
  const literalDecoder = literalTable(literalFreq)
  const literals = new Uint8Array(Math.ceil(literalCount / 4) * 4)
  const literalIn = new BackwardBits(input, headerEnd, literalEnd, literalBits)
  for (let i = 0; i < literals.length; i += 4) {
    for (let lane = 0; lane < 4; lane++) {
      const state = literalStates[lane]
      literals[i + lane] = literalDecoder.symbol[state]
      literalStates[lane] = literalDecoder.delta[state] + literalIn.pull(literalDecoder.bits[state])
    }
  }

  const lDecoder = valueTable(lFreq, L_STATES, L_EXTRA_BITS, L_BASE)
  const mDecoder = valueTable(mFreq, M_STATES, M_EXTRA_BITS, M_BASE)
  const dDecoder = valueTable(dFreq, D_STATES, D_EXTRA_BITS, D_BASE)
  const lmdIn = new BackwardBits(input, literalEnd, lmdEnd, lmdBits)
  const blockEnd = at + rawBytes
  let literal = 0
  let distance = -1
  for (let n = 0; n < matchCount; n++) {
    let bits = lmdIn.pull(lDecoder.totalBits[lState])
    const literalLength = lDecoder.base[lState] + (bits & ((1 << lDecoder.valueBits[lState]) - 1))
    lState = lDecoder.delta[lState] + (bits >>> lDecoder.valueBits[lState])
    bits = lmdIn.pull(mDecoder.totalBits[mState])
    const matchLength = mDecoder.base[mState] + (bits & ((1 << mDecoder.valueBits[mState]) - 1))
    mState = mDecoder.delta[mState] + (bits >>> mDecoder.valueBits[mState])
    bits = lmdIn.pull(dDecoder.totalBits[dState])
    const newDistance = dDecoder.base[dState] + (bits & ((1 << dDecoder.valueBits[dState]) - 1))
    dState = dDecoder.delta[dState] + (bits >>> dDecoder.valueBits[dState])
    // A distance of zero repeats the previous one.
    if (newDistance !== 0) distance = newDistance

    if (literal + literalLength > literalCount || at + literalLength + matchLength > blockEnd) {
      invalid('LZFSE sequence out of range')
    }
    out.set(literals.subarray(literal, literal + literalLength), at)
    literal += literalLength
    at += literalLength
    if (matchLength > 0) {
      if (distance <= 0 || distance > at) invalid('LZFSE match distance out of range')
      for (let i = 0; i < matchLength; i++, at++) out[at] = out[at - distance]
    }
  }
  if (at !== blockEnd) invalid('LZFSE block size does not match')
  return [lmdEnd, at]
}

/** Decodes an LZFSE stream that must expand to exactly `expectedSize`. */
export function decodeLzfse(input: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize)
  let pos = 0
  let at = 0
  for (;;) {
    const magic = u32le(input, pos)
    if (magic === END) break
    if (magic === STORED) {
      const size = u32le(input, pos + 4)
      if (pos + 8 + size > input.length || at + size > expectedSize) invalid('LZFSE stored block out of range')
      out.set(input.subarray(pos + 8, pos + 8 + size), at)
      pos += 8 + size
      at += size
    } else if (magic === LZVN) {
      const rawBytes = u32le(input, pos + 4)
      const payload = u32le(input, pos + 8)
      const start = pos + 12
      if (start + payload > input.length || at + rawBytes > expectedSize) invalid('LZFSE block out of range')
      const end = decodeLzvnInto(input, start, start + payload, out, at, at + rawBytes, 0)
      if (end !== at + rawBytes) invalid('LZFSE block size does not match')
      pos = start + payload
      at = end
    } else if (magic === V2) {
      [pos, at] = decodeV2Block(input, pos, out, at, expectedSize)
    } else if (magic === V1) {
      unsupported('LZFSE version 1 blocks')
    } else {
      invalid('unknown LZFSE block')
    }
  }
  if (at !== expectedSize) invalid('LZFSE output size does not match')
  return out
}
