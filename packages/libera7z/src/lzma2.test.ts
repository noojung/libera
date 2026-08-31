import { describe, expect, it } from 'vitest'
import {
  decodeLzma2,
  initialLzma2ChunkState,
  planLzma2Chunk,
  dictionaryPropertyForSize,
  dictionarySizeFromProperty,
  encodeLzma2,
  encodeLzma2Block,
  LZMA2_ENCODE_CHUNK_SIZE
} from './lzma2.js'

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

  describe('chunk control bytes', () => {
    // 7-Zip stores incompressible runs as control-2 chunks and then resumes
    // with a plain 0x80 chunk that continues the LZMA state across them. Only
    // control 1 - which resets the dictionary - invalidates state and
    // properties. Getting this wrong rejects real archives, so both decoders
    // read the rule from here.
    it('lets a stored chunk carry the LZMA state across', () => {
      const state = initialLzma2ChunkState()
      expect(planLzma2Chunk(0xe0, state)).toMatchObject({ kind: 'lzma', resetDictionary: true, readProperties: true, resetState: true })
      expect(planLzma2Chunk(0x02, state)).toMatchObject({ kind: 'uncompressed', resetDictionary: false })
      expect(planLzma2Chunk(0x80, state)).toMatchObject({ kind: 'lzma', resetDictionary: false, readProperties: false, resetState: false })
      expect(state).toEqual({ needsDictionaryReset: false, needsProperties: false, needsStateReset: false })
    })

    it('makes a dictionary-resetting stored chunk demand properties again', () => {
      const state = initialLzma2ChunkState()
      planLzma2Chunk(0xe0, state)
      expect(planLzma2Chunk(0x01, state)).toMatchObject({ kind: 'uncompressed', resetDictionary: true })
      expect(state).toEqual({ needsDictionaryReset: false, needsProperties: true, needsStateReset: true })
      expect(() => planLzma2Chunk(0x80, state)).toThrow('before coder properties')
      expect(() => planLzma2Chunk(0xa0, state)).toThrow('before coder properties')
      expect(planLzma2Chunk(0xc0, state)).toMatchObject({ readProperties: true, resetState: true })
    })

    it('rejects chunks that lean on state the stream never established', () => {
      expect(() => planLzma2Chunk(0x02, initialLzma2ChunkState())).toThrow('before resetting it')
      expect(() => planLzma2Chunk(0x80, initialLzma2ChunkState())).toThrow('before a dictionary reset')
      expect(() => planLzma2Chunk(0x7f, initialLzma2ChunkState())).toThrow('Invalid LZMA2 control byte')

      const noProperties = initialLzma2ChunkState()
      planLzma2Chunk(0x01, noProperties)
      expect(() => planLzma2Chunk(0x80, noProperties)).toThrow('before coder properties')

      // Properties alone do not open a stream: the dictionary must be reset first.
      expect(() => planLzma2Chunk(0xc0, initialLzma2ChunkState())).toThrow('before a dictionary reset')

      const resumed = initialLzma2ChunkState()
      planLzma2Chunk(0xe0, resumed)
      planLzma2Chunk(0x01, resumed)
      planLzma2Chunk(0xc0, resumed)
      expect(planLzma2Chunk(0x80, resumed).kind).toBe('lzma')
    })

    it('ends the stream on a zero control byte', () => {
      expect(planLzma2Chunk(0, initialLzma2ChunkState()).kind).toBe('end')
    })
  })
})
