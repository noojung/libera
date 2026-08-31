import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { inflateRaw } from './deflate.js'

describe('DEFLATE decoder', () => {
  it.each([0, 1, 6, 9])('decodes raw streams produced at level %s', level => {
    const input = Buffer.from('deflate huffman and matches\n'.repeat(4_000))
    const compressed = deflateRawSync(input, { level })
    expect(Buffer.from(inflateRaw(compressed, input.length))).toEqual(input)
  })

  it('rejects output sizes that do not match the stream', () => {
    const input = Buffer.from('size check')
    const compressed = deflateRawSync(input)
    expect(() => inflateRaw(compressed, input.length - 1)).toThrow('declared')
  })
})
