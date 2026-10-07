import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { decodeAdc } from './adc'
import { DmgFormatError } from './bytes'
import { ADC_VECTORS, type CodecVector, LZFSE_VECTORS } from './codecs.testData'
import { decodeLzfse } from './lzfse'
import { decodeLzvn } from './lzvn'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const packed = (vector: CodecVector) => new Uint8Array(Buffer.from(vector.packed, 'base64'))

/** Decoding damaged input may fail, but only as a format error, and never runs away. */
function expectOnlyFormatErrors(decode: () => unknown): void {
  try {
    decode()
  } catch (error) {
    expect(error).toBeInstanceOf(DmgFormatError)
  }
}

describe('LZFSE', () => {
  it.each(Object.entries(LZFSE_VECTORS))('decodes the reference %s stream', (_name, vector) => {
    expect(sha256(decodeLzfse(packed(vector), vector.size))).toBe(vector.sha256)
  })

  it('rejects a stream that expands to a different size than declared', () => {
    const vector = LZFSE_VECTORS.text
    expect(() => decodeLzfse(packed(vector), vector.size - 1)).toThrow(DmgFormatError)
    expect(() => decodeLzfse(packed(vector), vector.size + 1)).toThrow(DmgFormatError)
  })

  it('rejects truncated streams and unknown blocks', () => {
    const bytes = packed(LZFSE_VECTORS.text)
    for (const length of [0, 3, 40, 1000, bytes.length - 4]) {
      expect(() => decodeLzfse(bytes.subarray(0, length), LZFSE_VECTORS.text.size)).toThrow(DmgFormatError)
    }
    expect(() => decodeLzfse(new TextEncoder().encode('bvx?\0\0\0\0'), 0)).toThrow('unknown LZFSE block')
    expect(() => decodeLzfse(new TextEncoder().encode('bvx1\0\0\0\0'), 0)).toThrow('Unsupported DMG')
  })

  it('fails cleanly on corrupted streams', () => {
    let seed = 1
    const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit
    for (const vector of [LZFSE_VECTORS.text, LZFSE_VECTORS.random, LZFSE_VECTORS.lzvn]) {
      for (let round = 0; round < 150; round++) {
        const bytes = packed(vector)
        for (let flips = 1 + random(4); flips > 0; flips--) bytes[random(bytes.length)] = random(256)
        expectOnlyFormatErrors(() => decodeLzfse(bytes, vector.size))
      }
    }
  })
})

describe('LZVN', () => {
  // The `lzvn` vector is one LZVN block: a 12-byte block header, then the stream.
  const block = packed(LZFSE_VECTORS.lzvn)
  const stream = block.subarray(12, 12 + Buffer.from(block).readUInt32LE(8))

  it('decodes a stand-alone stream', () => {
    expect(sha256(decodeLzvn(stream, LZFSE_VECTORS.lzvn.size))).toBe(LZFSE_VECTORS.lzvn.sha256)
  })

  it('rejects undefined opcodes, distances before the output and overlong output', () => {
    expect(() => decodeLzvn(Uint8Array.of(0x70, 0, 0, 0), 10)).toThrow('undefined LZVN opcode')
    // One literal, then a three-byte match five bytes back: before the start.
    expect(() => decodeLzvn(Uint8Array.of(0x40, 0x05, 0x61), 4)).toThrow('distance out of range')
    // A match-only opcode before any distance was set.
    expect(() => decodeLzvn(Uint8Array.of(0xe1, 0x61, 0xf3), 4)).toThrow('distance out of range')
    expect(() => decodeLzvn(stream, LZFSE_VECTORS.lzvn.size - 1)).toThrow(DmgFormatError)
  })

  it('stops at the end marker and ignores what follows it', () => {
    const bytes = Uint8Array.of(0xe3, 0x61, 0x62, 0x63, 0x0e, 0x06, 0, 0, 0, 0, 0, 0, 0, 0xff)
    expect(new TextDecoder().decode(decodeLzvn(bytes, 3))).toBe('abc')
  })
})

describe('ADC', () => {
  it.each(ADC_VECTORS.map((vector, index) => [index, vector] as const))('decodes the reference chunk %i', (_index, vector) => {
    expect(sha256(decodeAdc(packed(vector), vector.size))).toBe(vector.sha256)
  })

  it('decodes literal runs and both reference forms', () => {
    // "abc", then 3 bytes from 3 back (two-byte form), then 4 bytes from 1 back (three-byte form).
    const bytes = Uint8Array.of(0x82, 0x61, 0x62, 0x63, 0x00, 0x02, 0x40, 0x00, 0x00)
    expect(new TextDecoder().decode(decodeAdc(bytes, 10))).toBe('abcabccccc')
  })

  it('rejects references before the output and sizes that do not match', () => {
    expect(() => decodeAdc(Uint8Array.of(0x80, 0x61, 0x00, 0x05), 4)).toThrow('ADC reference out of range')
    expect(() => decodeAdc(Uint8Array.of(0x80, 0x61), 2)).toThrow('ADC output size does not match')
    expect(() => decodeAdc(Uint8Array.of(0x83, 0x61), 4)).toThrow('ADC literal run out of range')
  })
})
