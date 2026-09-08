import { describe, expect, it } from 'vitest'
import { Lzma2StreamDecoder } from './lzma2Stream.js'
import { Lzma2StreamEncoder, dictionaryPropertyForSize } from './lzma2.js'

function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0
    out[index] = (state >>> 16) & 0xff
  }
  return out
}

function encode(input: Uint8Array, dictionarySize: number): Uint8Array {
  const encoder = new Lzma2StreamEncoder(dictionarySize, {}, input.length)
  const head = encoder.push(input)
  const tail = encoder.finish()
  const out = new Uint8Array(head.length + tail.length)
  out.set(head); out.set(tail, head.length)
  return out
}

/** Feeds the decoder in fixed pieces, the way a file stream would arrive. */
function decodeInPieces(framed: Uint8Array, property: number, piece: number): Uint8Array {
  const decoder = new Lzma2StreamDecoder(property)
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < framed.length; offset += piece) {
    decoder.push(framed.subarray(offset, Math.min(framed.length, offset + piece)))
    let out = decoder.pull()
    while (out) { parts.push(out); out = decoder.pull() }
  }
  decoder.end()
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return result
}

describe('decoding LZMA2 as it arrives', () => {
  const dictionarySize = 1 << 20
  const property = dictionaryPropertyForSize(dictionarySize)

  it.each([1, 7, 1000, 64 * 1024])('rebuilds the stream from %d-byte pieces', piece => {
    const source = noise(200_000)
    expect(decodeInPieces(encode(source, dictionarySize), property, piece)).toEqual(source)
  })

  it('spans a repeat that no single chunk could hold', () => {
    const block = noise(120_000, 3)
    const source = new Uint8Array(block.length * 2)
    source.set(block); source.set(block, block.length)
    expect(decodeInPieces(encode(source, dictionarySize), property, 4096)).toEqual(source)
  })

  it('reports a stream that stops before its end marker', () => {
    const framed = encode(noise(50_000), dictionarySize)
    const decoder = new Lzma2StreamDecoder(property)
    decoder.push(framed.subarray(0, framed.length - 10))
    while (decoder.pull()) { /* drain */ }
    expect(() => decoder.end()).toThrow('Truncated LZMA2 stream')
  })

  it('knows when the stream has ended', () => {
    const framed = encode(noise(1000), dictionarySize)
    const decoder = new Lzma2StreamDecoder(property)
    expect(decoder.finished).toBe(false)
    decoder.push(framed)
    while (decoder.pull()) { /* drain */ }
    expect(decoder.finished).toBe(true)
    decoder.end()
  })
})
