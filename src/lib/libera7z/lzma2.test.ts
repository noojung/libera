import { describe, expect, it } from 'vitest'
import {
  decodeLzma2,
  dictionaryPropertyForSize,
  dictionarySizeFromProperty,
  encodeLzma2,
  encodeLzma2Block,
  LZMA2_ENCODE_CHUNK_SIZE
} from './lzma2'

describe('pure TypeScript LZMA2', () => {
  it('round-trips compressible and varied chunks', () => {
    const compressible = new TextEncoder().encode('pure-js-seven-zip\n'.repeat(4_000))
    const varied = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 131 + 17) & 0xff)

    for (const source of [compressible, varied]) {
      const encoded = encodeLzma2(source)
      if (source === compressible) expect(encoded.compressedChunks).toBeGreaterThan(0)
      expect(decodeLzma2(encoded.data, dictionaryPropertyForSize(1024 * 1024), source.length)).toEqual(source)
    }
  })

  it('maps dictionary sizes to valid LZMA2 properties', () => {
    expect(dictionarySizeFromProperty(0)).toBe(4096)
    expect(dictionaryPropertyForSize(4096)).toBe(0)
    expect(dictionarySizeFromProperty(dictionaryPropertyForSize(16 * 1024 * 1024)))
      .toBeGreaterThanOrEqual(16 * 1024 * 1024)
    expect(dictionarySizeFromProperty(40)).toBe(0xffffffff)
  })

  it('rejects invalid properties, dictionary sizes and block sizes', () => {
    expect(() => dictionarySizeFromProperty(41)).toThrow('Invalid LZMA2 dictionary property')
    expect(() => dictionaryPropertyForSize(1024)).toThrow(RangeError)
    expect(() => encodeLzma2Block(new Uint8Array(0))).toThrow('Invalid LZMA2 encoder chunk size')
    expect(() => encodeLzma2Block(new Uint8Array(LZMA2_ENCODE_CHUNK_SIZE + 1)))
      .toThrow('Invalid LZMA2 encoder chunk size')
  })

  it('rejects malformed streams and incorrect expanded sizes', () => {
    expect(() => decodeLzma2(Uint8Array.of(0x03, 0), 0)).toThrow('Invalid LZMA2 control byte')
    expect(() => decodeLzma2(Uint8Array.of(0, 1), 0)).toThrow('trailing bytes')

    const encoded = encodeLzma2(Uint8Array.of(1, 2, 3))
    expect(() => decodeLzma2(encoded.data, 0, 4)).toThrow('instead of 4')
  })

  it('honours cancellation before encoding and decoding chunks', () => {
    const controller = new AbortController()
    controller.abort()

    expect(() => encodeLzma2(Uint8Array.of(1), controller.signal))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }))
    expect(() => decodeLzma2(Uint8Array.of(0), 0, 0, controller.signal))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }))
  })
})
