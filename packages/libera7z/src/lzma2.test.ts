import { describe, expect, it } from 'vitest'
import {
  decodeLzma2,
  initialLzma2ChunkState,
  planLzma2Chunk,
  dictionaryPropertyForSize,
  dictionarySizeFromProperty,
  encodeLzma2,
  Lzma2StreamEncoder,
  LZMA2_ENCODE_CHUNK_SIZE
} from './lzma2.js'

/** Walks a framed LZMA2 run and reports the control byte of every chunk. */
function chunkControls(framed: Uint8Array): number[] {
  const controls: number[] = []
  let offset = 0
  while (offset < framed.length && framed[offset] !== 0) {
    const control = framed[offset]
    controls.push(control)
    const packed = ((framed[offset + 3] << 8) | framed[offset + 4]) + 1
    offset += (control >= 0xc0 ? 6 : 5) + packed
  }
  return controls
}

/** Pseudo-random bytes, so a repeat is the only thing the coder can match. */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length)
  // Math.imul keeps the multiply in 32 bits; the plain operator overflows what
  // a double holds exactly and the sequence degenerates into a pattern.
  let state = seed
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) | 0
    out[index] = (state >>> 16) & 0xff
  }
  return out
}

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

  it('rejects invalid properties and dictionary sizes', () => {
    expect(() => dictionarySizeFromProperty(41)).toThrow('Invalid LZMA2 dictionary property')
    expect(() => dictionaryPropertyForSize(1024)).toThrow(RangeError)
  })

  it('refuses to encode once the stream is closed', () => {
    const encoder = new Lzma2StreamEncoder(4096)
    encoder.push(Uint8Array.of(1, 2, 3))
    encoder.finish()
    expect(() => encoder.push(Uint8Array.of(4))).toThrow('closed')
    expect(() => encoder.finish()).toThrow('closed')
  })

  // The dictionary spanning the whole stream is the point of the encoder: a
  // coder that reset it every chunk could never reach a repeat this far back,
  // and both the ratio and the control bytes below would say so.
  it('keeps one dictionary across chunks so a distant repeat still matches', () => {
    const block = noise(300_000)
    expect(block.length).toBeGreaterThan(LZMA2_ENCODE_CHUNK_SIZE * 4)
    const doubled = new Uint8Array(block.length * 2)
    doubled.set(block)
    doubled.set(block, block.length)

    const once = encodeLzma2(block)
    const twice = encodeLzma2(doubled)
    const property = dictionaryPropertyForSize(1024 * 1024)
    expect(decodeLzma2(twice.data, property, doubled.length)).toEqual(doubled)

    // The second copy is one long match, so the pair costs about what one does.
    expect(twice.data.length).toBeLessThan(once.data.length * 1.1)

    const controls = chunkControls(twice.data)
    expect(controls.length).toBeGreaterThan(4)
    expect(controls[0]).toBe(0xe0)
    expect(controls.slice(1).every(control => control === 0x80)).toBe(true)
  })

  // The encoder is told both the dictionary and, where the caller knows it,
  // the length of the stream, and holds its reach to the smaller. Sizing its
  // tables from the stream is what keeps a small entry under a large
  // dictionary cheap, but the dictionary is what the reader allocates, so a
  // long stream must not be allowed to reach past it.
  it('never reaches back further than the dictionary the reader allocates', () => {
    // The one repeat sits further back than the dictionary but well inside the
    // stream, so an encoder that took the stream for its limit would name a
    // distance the reader cannot serve. The reader rejects exactly that, which
    // is what makes this the cap that matters.
    const dictionarySize = 64 * 1024
    const repeated = noise(8_000, 3)
    const filler = noise(300_000, 4)
    const input = new Uint8Array(repeated.length * 2 + filler.length)
    input.set(repeated)
    input.set(filler, repeated.length)
    input.set(repeated, repeated.length + filler.length)

    const encoder = new Lzma2StreamEncoder(dictionarySize, {}, input.length)
    const head = encoder.push(input)
    const tail = encoder.finish()
    const framed = new Uint8Array(head.length + tail.length)
    framed.set(head)
    framed.set(tail, head.length)

    expect(decodeLzma2(framed, dictionaryPropertyForSize(dictionarySize), input.length)).toEqual(input)
  })

  it('cuts chunks the header can carry, even on data LZMA cannot shrink', () => {
    const encoded = encodeLzma2(noise(400_000, 99))
    for (let offset = 0; offset < encoded.data.length && encoded.data[offset] !== 0;) {
      const control = encoded.data[offset]
      const unpacked = (((control & 0x1f) << 16) | (encoded.data[offset + 1] << 8) | encoded.data[offset + 2]) + 1
      const packed = ((encoded.data[offset + 3] << 8) | encoded.data[offset + 4]) + 1
      expect(packed).toBeLessThanOrEqual(0x10000)
      expect(unpacked).toBeLessThanOrEqual(LZMA2_ENCODE_CHUNK_SIZE + 273)
      offset += (control >= 0xc0 ? 6 : 5) + packed
    }
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
