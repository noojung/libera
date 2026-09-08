import zlib from 'zlib'
import { describe, expect, it } from 'vitest'
import { hasXzSignature, XzFormatError, XzStreamDecoder } from './reader'
import { XZ_FIXTURES, XZ_SAMPLE_DEFLATED } from './fixtures.testData'

const SAMPLE = new Uint8Array(zlib.inflateSync(Buffer.from(XZ_SAMPLE_DEFLATED, 'base64')))
const fixture = (key: string): Uint8Array => new Uint8Array(Buffer.from(XZ_FIXTURES[key], 'base64'))

/** Feeds the decoder in fixed pieces, the way a file stream arrives. */
function decode(stream: Uint8Array, piece = 64 * 1024): Uint8Array {
  const decoder = new XzStreamDecoder()
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < stream.length; offset += piece) {
    decoder.push(stream.subarray(offset, Math.min(stream.length, offset + piece)))
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

// Read against what `xz` itself writes, since the container is only worth
// reading if the reference tool's output goes through it.
describe('reading the xz container', () => {
  it.each(['crc64', 'crc32', 'none', 'sha256'])('reads a stream checked with %s', key => {
    expect(decode(fixture(key))).toEqual(SAMPLE)
  })

  it.each(['preset0', 'preset9e'])('reads a stream written at %s', key => {
    expect(decode(fixture(key))).toEqual(SAMPLE)
  })

  it('reads a stream cut into several blocks', () => {
    expect(decode(fixture('multiBlock'))).toEqual(SAMPLE)
  })

  it('reads two streams concatenated into one file', () => {
    const doubled = new Uint8Array(SAMPLE.length * 2)
    doubled.set(SAMPLE)
    doubled.set(SAMPLE, SAMPLE.length)
    expect(decode(fixture('concatenated'))).toEqual(doubled)
  })

  it.each([1, 3, 997, 4096])('rebuilds the same bytes from %d-byte pieces', piece => {
    expect(decode(fixture('crc64'), piece)).toEqual(SAMPLE)
  })

  it('knows an xz stream by its signature', () => {
    expect(hasXzSignature(fixture('crc64'))).toBe(true)
    expect(hasXzSignature(Uint8Array.of(0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0))).toBe(false)
    expect(hasXzSignature(Uint8Array.of(0xfd, 0x37))).toBe(false)
  })
})

describe('refusing what it cannot read', () => {
  it('rejects a file that is not xz at all', () => {
    const decoder = new XzStreamDecoder()
    decoder.push(new Uint8Array(64))
    expect(() => decoder.pull()).toThrow(XzFormatError)
  })

  it('rejects a stream that stops early', () => {
    const stream = fixture('crc64')
    const decoder = new XzStreamDecoder()
    decoder.push(stream.subarray(0, stream.length - 20))
    while (decoder.pull()) { /* drain */ }
    expect(() => decoder.end()).toThrow('Truncated xz stream')
  })

  // Corrupting the data anywhere else fails in the decoder before the check is
  // ever compared, so these fixtures flip a byte inside the stored check alone:
  // the data decodes, and only the check disagrees. It is the one shape that
  // tells whether the check is being verified at all.
  it('rejects a block whose CRC32 does not match', () => {
    expect(() => decode(fixture('badCrc32'))).toThrow('failed its CRC32 check')
  })

  it('rejects a block whose CRC64 does not match', () => {
    expect(() => decode(fixture('badCrc64'))).toThrow('failed its CRC64 check')
  })

  // A BCJ or delta filter ahead of LZMA2 is legal xz with no chain here, and
  // decoding it as though the filter were absent would hand back noise. `xz`
  // writes it as a chain of two, which is what this meets in practice; the
  // reader's check on the filter's own id guards the shape it never sees.
  it('refuses a filter it cannot apply rather than misreading it', () => {
    expect(() => decode(fixture('bcjFilter'))).toThrow(/filter/)
  })

  it('rejects a damaged stream header', () => {
    const damaged = fixture('crc64').slice()
    damaged[7] ^= 0x0f
    const decoder = new XzStreamDecoder()
    decoder.push(damaged)
    expect(() => decoder.pull()).toThrow(XzFormatError)
  })
})
