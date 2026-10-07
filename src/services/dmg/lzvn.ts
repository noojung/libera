import { invalid } from './bytes'

// LZVN, Apple's byte-oriented LZ77 codec. It appears on its own in
// filesystem-compressed files and inside LZFSE streams, for blocks too small
// for the entropy coder. Every opcode carries up to three literals, a match,
// or both; its top bits pick the layout:
//
//   LLMMMDDD DDDDDDDD          small distance
//   101LLMMM DDDDDDMM DDDDDDDD medium distance
//   LLMMM111 DDDDDDDD DDDDDDDD large distance
//   LLMMM110                   previous distance
//   1110LLLL / 11100000 LLLLLLLL  literals only
//   1111MMMM / 11110000 MMMMMMMM  match only, previous distance
//   00000110 + 7 bytes         end of stream; 00001110 and 00010110 do nothing

const SMALL_D = 0, MEDIUM_D = 1, LARGE_D = 2, PREVIOUS_D = 3, SMALL_L = 4, LARGE_L = 5
const SMALL_M = 6, LARGE_M = 7, END = 8, NOP = 9, UNDEFINED = 10

const OPS = new Uint8Array(256)
for (let opc = 0; opc < 256; opc++) {
  let op: number
  if (opc >= 0xf0) op = opc === 0xf0 ? LARGE_M : SMALL_M
  else if (opc >= 0xe0) op = opc === 0xe0 ? LARGE_L : SMALL_L
  else if (opc >= 0xa0 && opc < 0xc0) op = MEDIUM_D
  else if (opc >= 0x70 && opc < 0x80) op = UNDEFINED
  else if ((opc & 7) === 7) op = LARGE_D
  else if ((opc & 7) === 6) {
    op = opc === 0x06 ? END : opc === 0x0e || opc === 0x16 ? NOP : opc < 0x40 ? UNDEFINED : PREVIOUS_D
  } else op = SMALL_D
  OPS[opc] = op
}

/**
 * Decodes `input[start, end)` into `out` from `at`, stopping at the end
 * marker. Matches may reach back to `base`, which is where the whole output
 * began. Returns where the output stopped.
 */
export function decodeLzvnInto(
  input: Uint8Array, start: number, end: number,
  out: Uint8Array, at: number, limit: number, base = at
): number {
  let pos = start
  let previous = 0
  while (pos < end) {
    const opc = input[pos]
    let literals = 0
    let match = 0
    let distance = previous
    let length: number
    switch (OPS[opc]) {
      case SMALL_D:
        length = 2
        literals = opc >> 6
        match = (opc >> 3 & 7) + 3
        if (pos + 1 < end) distance = (opc & 7) << 8 | input[pos + 1]
        break
      case MEDIUM_D: {
        length = 3
        literals = opc >> 3 & 3
        if (pos + 2 < end) {
          const word = input[pos + 1] | input[pos + 2] << 8
          match = ((opc & 7) << 2 | word & 3) + 3
          distance = word >> 2
        }
        break
      }
      case LARGE_D:
        length = 3
        literals = opc >> 6
        match = (opc >> 3 & 7) + 3
        if (pos + 2 < end) distance = input[pos + 1] | input[pos + 2] << 8
        break
      case PREVIOUS_D:
        length = 1
        literals = opc >> 6
        match = (opc >> 3 & 7) + 3
        break
      case SMALL_L:
        length = 1
        literals = opc & 0xf
        break
      case LARGE_L:
        length = 2
        if (pos + 1 < end) literals = input[pos + 1] + 16
        break
      case SMALL_M:
        length = 1
        match = opc & 0xf
        break
      case LARGE_M:
        length = 2
        if (pos + 1 < end) match = input[pos + 1] + 16
        break
      case NOP:
        pos += 1
        continue
      case END:
        return at
      default:
        invalid('undefined LZVN opcode')
    }
    if (pos + length + literals > end) invalid('truncated LZVN stream')
    pos += length
    if (at + literals + match > limit) invalid('LZVN output exceeds its declared size')
    if (literals > 0) {
      out.set(input.subarray(pos, pos + literals), at)
      pos += literals
      at += literals
    }
    if (match > 0) {
      if (distance === 0 || distance > at - base) invalid('LZVN match distance out of range')
      previous = distance
      for (let i = 0; i < match; i++, at++) out[at] = out[at - distance]
    }
  }
  return at
}

/** Decodes a stand-alone LZVN stream that must expand to exactly `expectedSize`. */
export function decodeLzvn(input: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize)
  if (decodeLzvnInto(input, 0, input.length, out, 0, expectedSize) !== expectedSize) {
    invalid('LZVN output size does not match')
  }
  return out
}
