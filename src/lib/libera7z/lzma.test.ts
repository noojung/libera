import { describe, expect, it } from 'vitest'
import { encodeLzma, LzmaDecoder, parseLzmaProperties } from './lzma'

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
