import { describe, expect, it } from 'vitest'
import {
  bitVector,
  ByteReader,
  ByteWriter,
  concatBytes,
  readBitVector,
  uint32Bytes,
  uint64ToSafeNumber
} from './binary.js'

describe('7z binary primitives', () => {
  it('round-trips every variable-width uint64 encoding', () => {
    const values = [0n, 0x7fn, 0x80n, 0x3fffn, 0x4000n, 0xffffffffn, 0x123456789abcdef0n, 0xffffffffffffffffn]
    const writer = new ByteWriter()
    values.forEach(value => writer.variableUint64(value))

    const reader = new ByteReader(writer.build())
    expect(values.map(() => reader.variableUint64())).toEqual(values)
    expect(reader.remaining).toBe(0)
  })

  it('writes and reads fixed-width little-endian integers', () => {
    const bytes = new ByteWriter()
      .uint32(0x78563412)
      .uint64(0x123456789abcdef0n)
      .build()
    const reader = new ByteReader(bytes)

    expect(reader.uint32()).toBe(0x78563412)
    expect(reader.uint64()).toBe(0x123456789abcdef0n)
    reader.assertFinished('fixed-width values')
    expect(uint32Bytes(0x78563412)).toEqual(Uint8Array.of(0x12, 0x34, 0x56, 0x78))
  })

  it('packs and reads 7z bit vectors', () => {
    const values = [true, false, true, false, false, false, false, true, true]
    const encoded = bitVector(values)

    expect(encoded).toEqual(Uint8Array.of(0xa1, 0x80))
    expect(readBitVector(new ByteReader(encoded), values.length)).toEqual(values)
  })

  it('concatenates byte arrays without sharing their storage', () => {
    const first = Uint8Array.of(1, 2)
    const result = concatBytes([first, Uint8Array.of(3)])
    first[0] = 9

    expect(result).toEqual(Uint8Array.of(1, 2, 3))
  })

  it('rejects out-of-range integers and truncated reads', () => {
    expect(() => new ByteWriter().uint64(-1n)).toThrow(RangeError)
    expect(() => new ByteWriter().variableUint64(0x1_0000_0000_0000_0000n)).toThrow(RangeError)
    expect(() => uint64ToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'value'))
      .toThrow("value exceeds JavaScript's safe range")
    expect(() => new ByteReader(Uint8Array.of(1)).read(2)).toThrow('extends beyond the available bytes')
  })
})
