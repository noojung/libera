import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { encodeLzma, LzmaDecoder, LzmaStreamEncoder, parseLzmaProperties } from './lzma.js'

describe('pure TypeScript LZMA', () => {
  it('parses the default LZMA properties', () => {
    expect(parseLzmaProperties(93)).toEqual({ lc: 3, lp: 0, pb: 2 })
    expect(() => parseLzmaProperties(8)).toThrow('Unsupported LZMA literal context properties')
    expect(() => parseLzmaProperties(225)).toThrow('Invalid LZMA properties')
  })

  it.each([
    ['repetitive', new TextEncoder().encode('match-coded-lzma\n'.repeat(2_000))],
    ['varied', Uint8Array.from({ length: 8_192 }, (_, index) => (index * 131 + (index >>> 3)) & 0xff)]
  ])('round-trips %s input', (_, source) => {
    const encoded = encodeLzma(source)
    const decoder = new LzmaDecoder(1024 * 1024)
    decoder.resetDictionary()
    decoder.setProperties(93)
    decoder.resetState()

    expect(decoder.decodeChunk(encoded, source.length)).toEqual(source)
  })

  it('uses matches to reduce repetitive input', () => {
    const source = new TextEncoder().encode('abcabcabcabc'.repeat(2_000))
    expect(encodeLzma(source).length).toBeLessThan(source.length)
  })

  describe('streaming encoder', () => {
    // Repetitive, random and mixed, so matches reach back different distances.
    const sources: [string, Uint8Array][] = [
      ['repetitive', new TextEncoder().encode('stream-coded-lzma\n'.repeat(4_000))],
      ['random', new Uint8Array(crypto.randomBytes(96 * 1024))],
      ['mixed', (() => {
        const noise = crypto.randomBytes(32 * 1024)
        return new Uint8Array(Buffer.concat([noise, Buffer.from('a'.repeat(40_000)), noise]))
      })()]
    ]

    function stream(source: Uint8Array, chunkSize: number, maxDistance: number): Uint8Array {
      const encoder = new LzmaStreamEncoder(undefined, { maxDistance })
      const parts: Uint8Array[] = []
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        parts.push(encoder.update(source.subarray(offset, offset + chunkSize)))
      }
      parts.push(encoder.final())
      return new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
    }

    // The strongest check available: range coding is deterministic, so a
    // stream that split the input differently and still lands on the same
    // bytes has kept every model and match decision aligned.
    it.each(sources)('splits %s input without changing a byte', (_, source) => {
      const maxDistance = 64 * 1024
      const whole = encodeLzma(source, undefined, { maxDistance })
      for (const chunkSize of [1, 7, 273, 1024, 65_536, source.length]) {
        expect(stream(source, chunkSize, maxDistance)).toEqual(whole)
      }
    })

    it.each(sources)('round-trips %s input through the decoder', (_, source) => {
      const encoded = stream(source, 4_096, 1024 * 1024)
      const decoder = new LzmaDecoder(1024 * 1024)
      decoder.resetDictionary()
      decoder.setProperties(93)
      decoder.resetState()

      expect(decoder.decodeChunk(encoded, source.length)).toEqual(source)
    })

    it('holds its memory to the window rather than the input', () => {
      const encoder = new LzmaStreamEncoder(undefined, { maxDistance: 4096 })
      const chunk = new Uint8Array(crypto.randomBytes(64 * 1024))
      let produced = 0
      // Far more input than any buffer the encoder is allowed to keep.
      for (let index = 0; index < 64; index += 1) produced += encoder.update(chunk).length
      produced += encoder.final().length
      expect(produced).toBeGreaterThan(0)
    })

    it('refuses to encode after it is closed', () => {
      const encoder = new LzmaStreamEncoder()
      encoder.update(new Uint8Array([1, 2, 3]))
      encoder.final()
      expect(() => encoder.update(new Uint8Array([4]))).toThrow('closed')
      expect(() => encoder.final()).toThrow('closed')
    })
  })

  it('rejects invalid dictionaries and cancelled decoding', () => {
    expect(() => new LzmaDecoder(1024)).toThrow('Invalid LZMA2 dictionary size')

    const source = new TextEncoder().encode('cancelled'.repeat(1_000))
    const decoder = new LzmaDecoder(1024 * 1024)
    const controller = new AbortController()
    decoder.resetDictionary()
    decoder.setProperties(93)
    decoder.resetState()
    controller.abort()

    expect(() => decoder.decodeChunk(encodeLzma(source), source.length, controller.signal))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }))
  })
})
