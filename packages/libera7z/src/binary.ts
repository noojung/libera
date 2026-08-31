import { invalidArchive } from './errors.js'

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

export class ByteWriter {
  private readonly bytes: number[] = []

  byte(value: number): this {
    this.bytes.push(value & 0xff)
    return this
  }

  bytesValue(value: Uint8Array): this {
    for (const byte of value) this.bytes.push(byte)
    return this
  }

  uint32(value: number): this {
    for (let shift = 0; shift < 32; shift += 8) this.byte(value >>> shift)
    return this
  }

  uint64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError('uint64 is out of range')
    for (let shift = 0n; shift < 64n; shift += 8n) this.byte(Number((value >> shift) & 0xffn))
    return this
  }

  variableUint64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError('7z uint64 is out of range')

    let firstByte = 0
    let mask = 0x80
    for (let extraBytes = 0; extraBytes < 8; extraBytes += 1) {
      const highBits = 7 - extraBytes
      const limit = 1n << BigInt(highBits + 8 * extraBytes)
      if (value < limit) {
        firstByte |= Number(value >> BigInt(8 * extraBytes))
        this.byte(firstByte)
        for (let index = 0; index < extraBytes; index += 1) {
          this.byte(Number((value >> BigInt(8 * index)) & 0xffn))
        }
        return this
      }
      firstByte |= mask
      mask >>>= 1
    }

    this.byte(0xff)
    for (let index = 0; index < 8; index += 1) {
      this.byte(Number((value >> BigInt(8 * index)) & 0xffn))
    }
    return this
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }

  get length(): number {
    return this.bytes.length
  }
}

export class ByteReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  get position(): number {
    return this.offset
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw invalidArchive('Unexpected end of 7z header')
    return this.bytes[this.offset++]
  }

  read(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw invalidArchive('7z header field extends beyond the available bytes')
    }
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  uint32(): number {
    const value = this.byte() |
      (this.byte() << 8) |
      (this.byte() << 16) |
      (this.byte() << 24)
    return value >>> 0
  }

  uint64(): bigint {
    let value = 0n
    for (let shift = 0n; shift < 64n; shift += 8n) value |= BigInt(this.byte()) << shift
    return value
  }

  variableUint64(): bigint {
    const first = this.byte()
    let mask = 0x80
    let value = 0n

    for (let extraBytes = 0; extraBytes < 8; extraBytes += 1) {
      if ((first & mask) === 0) {
        value |= BigInt(first & (mask - 1)) << BigInt(8 * extraBytes)
        return value
      }
      value |= BigInt(this.byte()) << BigInt(8 * extraBytes)
      mask >>>= 1
    }

    return value
  }

  safeNumber(label: string): number {
    const value = this.variableUint64()
    if (value > MAX_SAFE_BIGINT) throw invalidArchive(`${label} exceeds JavaScript's safe allocation range`)
    return Number(value)
  }

  assertFinished(label: string): void {
    if (this.remaining !== 0) throw invalidArchive(`${label} contains trailing bytes`)
  }
}

export function uint64ToSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) throw invalidArchive(`${label} exceeds JavaScript's safe range`)
  return Number(value)
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export function bitVector(values: readonly boolean[]): Uint8Array {
  const result = new Uint8Array(Math.ceil(values.length / 8))
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]) result[index >> 3] |= 0x80 >> (index & 7)
  }
  return result
}

export function readBitVector(reader: ByteReader, count: number): boolean[] {
  const bytes = reader.read(Math.ceil(count / 8))
  return Array.from({ length: count }, (_, index) => (bytes[index >> 3] & (0x80 >> (index & 7))) !== 0)
}

export function uint32Bytes(value: number): Uint8Array {
  return new ByteWriter().uint32(value).build()
}
