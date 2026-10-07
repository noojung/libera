import { invalid } from './bytes'

/**
 * Apple Data Compression, the UDCO image codec: literal runs and back
 * references, each introduced by one byte.
 *
 *   1nnnnnnn                    n + 1 literal bytes follow
 *   01nnnnnn dddddddd dddddddd  copy n + 4 bytes from d + 1 back
 *   00nnnndd dddddddd           copy n + 3 bytes from d + 1 back
 */
export function decodeAdc(input: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize)
  let at = 0
  let pos = 0
  while (pos < input.length) {
    const op = input[pos++]
    if (op & 0x80) {
      const count = (op & 0x7f) + 1
      if (pos + count > input.length || at + count > expectedSize) invalid('ADC literal run out of range')
      out.set(input.subarray(pos, pos + count), at)
      pos += count
      at += count
      continue
    }
    let count: number
    let distance: number
    if (op & 0x40) {
      if (pos + 2 > input.length) invalid('truncated ADC stream')
      count = (op & 0x3f) + 4
      distance = (input[pos] << 8 | input[pos + 1]) + 1
      pos += 2
    } else {
      if (pos + 1 > input.length) invalid('truncated ADC stream')
      count = (op >> 2) + 3
      distance = ((op & 3) << 8 | input[pos]) + 1
      pos += 1
    }
    if (distance > at || at + count > expectedSize) invalid('ADC reference out of range')
    // Overlapping copies repeat what they just wrote, so they go a byte at a time.
    for (let i = 0; i < count; i++, at++) out[at] = out[at - distance]
  }
  if (at !== expectedSize) invalid('ADC output size does not match its chunk')
  return out
}
