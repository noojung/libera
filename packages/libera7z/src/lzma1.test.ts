import { describe, expect, it } from 'vitest'
import { encodeLzma } from './lzma'
import { decodeLzma1, parseLzma1Properties } from './lzma1'

describe('LZMA1 codec', () => {
  it('parses 7z properties and decodes a raw LZMA stream', () => {
    const input = new TextEncoder().encode('standalone lzma stream\n'.repeat(2_000))
    const properties = Uint8Array.of(93, 0, 0, 16, 0)

    expect(parseLzma1Properties(properties)).toEqual({
      property: 93,
      dictionarySize: 1024 * 1024
    })
    expect(decodeLzma1(encodeLzma(input), properties, input.length)).toEqual(input)
  })

  it('rejects malformed properties', () => {
    expect(() => parseLzma1Properties(Uint8Array.of(93))).toThrow('properties are malformed')
  })
})
