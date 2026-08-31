import { invalidArchive, throwIfCancelled } from './errors.js'

class BitReader {
  private offset = 0
  private bits = 0
  private bitCount = 0

  constructor(private readonly input: Uint8Array) {}

  read(count: number): number {
    if (count < 0 || count > 24) throw new RangeError('Invalid DEFLATE bit count')
    while (this.bitCount < count) {
      if (this.offset >= this.input.length) throw invalidArchive('Truncated DEFLATE stream')
      this.bits |= this.input[this.offset++] << this.bitCount
      this.bitCount += 8
    }
    const mask = count === 0 ? 0 : (1 << count) - 1
    const value = this.bits & mask
    this.bits >>>= count
    this.bitCount -= count
    return value
  }

  align(): void {
    this.bits = 0
    this.bitCount = 0
  }

  bytes(length: number): Uint8Array {
    this.align()
    if (length < 0 || this.offset + length > this.input.length) throw invalidArchive('Truncated DEFLATE stored block')
    const result = this.input.subarray(this.offset, this.offset + length)
    this.offset += length
    return result
  }
}

function reverseBits(value: number, length: number): number {
  let result = 0
  for (let index = 0; index < length; index += 1) {
    result = (result << 1) | ((value >>> index) & 1)
  }
  return result
}

class HuffmanTable {
  private readonly symbols = new Map<number, number>()
  private readonly maxLength: number

  constructor(lengths: readonly number[]) {
    this.maxLength = Math.max(0, ...lengths)
    if (this.maxLength > 15) throw invalidArchive('DEFLATE Huffman code is too long')
    const counts = new Uint16Array(this.maxLength + 1)
    for (const length of lengths) {
      if (length < 0 || length > 15) throw invalidArchive('Invalid DEFLATE Huffman length')
      if (length > 0) counts[length] += 1
    }
    const next = new Uint16Array(this.maxLength + 1)
    let code = 0
    for (let bits = 1; bits <= this.maxLength; bits += 1) {
      code = (code + counts[bits - 1]) << 1
      if (code + counts[bits] > (1 << bits)) throw invalidArchive('Oversubscribed DEFLATE Huffman tree')
      next[bits] = code
    }
    lengths.forEach((length, symbol) => {
      if (length === 0) return
      const reversed = reverseBits(next[length]++, length)
      this.symbols.set((length << 16) | reversed, symbol)
    })
  }

  decode(reader: BitReader): number {
    let code = 0
    for (let length = 1; length <= this.maxLength; length += 1) {
      code |= reader.read(1) << (length - 1)
      const symbol = this.symbols.get((length << 16) | code)
      if (symbol !== undefined) return symbol
    }
    throw invalidArchive('Invalid DEFLATE Huffman symbol')
  }
}

const LENGTH_BASE_32 = [
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258
]
const LENGTH_BASE_64 = [...LENGTH_BASE_32.slice(0, 28), 3]
const LENGTH_EXTRA_32 = [
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4,
  5, 5, 5, 5, 0
]
const LENGTH_EXTRA_64 = [...LENGTH_EXTRA_32.slice(0, 28), 16]
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13,
  17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577, 32769, 49153
]
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2,
  3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13, 14, 14
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

function fixedTables(): [HuffmanTable, HuffmanTable] {
  const literalLengths = new Array<number>(288).fill(0)
  literalLengths.fill(8, 0, 144)
  literalLengths.fill(9, 144, 256)
  literalLengths.fill(7, 256, 280)
  literalLengths.fill(8, 280)
  return [new HuffmanTable(literalLengths), new HuffmanTable(new Array<number>(32).fill(5))]
}

function dynamicTables(reader: BitReader): [HuffmanTable, HuffmanTable] {
  const literalCount = reader.read(5) + 257
  const distanceCount = reader.read(5) + 1
  const codeLengthCount = reader.read(4) + 4
  const codeLengths = new Array<number>(19).fill(0)
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengths[CODE_LENGTH_ORDER[index]] = reader.read(3)
  }
  const codeTable = new HuffmanTable(codeLengths)
  const lengths: number[] = []
  while (lengths.length < literalCount + distanceCount) {
    const symbol = codeTable.decode(reader)
    if (symbol <= 15) {
      lengths.push(symbol)
    } else if (symbol === 16) {
      if (lengths.length === 0) throw invalidArchive('DEFLATE repeats a missing Huffman length')
      const repeat = reader.read(2) + 3
      const previous = lengths.at(-1)!
      for (let index = 0; index < repeat; index += 1) lengths.push(previous)
    } else if (symbol === 17) {
      const repeat = reader.read(3) + 3
      for (let index = 0; index < repeat; index += 1) lengths.push(0)
    } else if (symbol === 18) {
      const repeat = reader.read(7) + 11
      for (let index = 0; index < repeat; index += 1) lengths.push(0)
    } else {
      throw invalidArchive('Invalid DEFLATE code-length symbol')
    }
    if (lengths.length > literalCount + distanceCount) throw invalidArchive('DEFLATE Huffman lengths overflow')
  }
  const literalLengths = lengths.slice(0, literalCount)
  if (literalLengths[256] === 0) throw invalidArchive('DEFLATE block has no end symbol')
  return [
    new HuffmanTable(literalLengths),
    new HuffmanTable(lengths.slice(literalCount))
  ]
}

export function inflateRaw(
  input: Uint8Array,
  expectedSize: number,
  deflate64 = false,
  signal?: AbortSignal
): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw invalidArchive('Invalid DEFLATE output size')
  const reader = new BitReader(input)
  const output = new Uint8Array(expectedSize)
  let outputOffset = 0
  let final = false
  while (!final) {
    throwIfCancelled(signal)
    final = reader.read(1) !== 0
    const type = reader.read(2)
    if (type === 0) {
      reader.align()
      const length = reader.read(16)
      const inverse = reader.read(16)
      if (((length ^ 0xffff) & 0xffff) !== inverse) throw invalidArchive('DEFLATE stored block length is corrupt')
      const bytes = reader.bytes(length)
      if (outputOffset + bytes.length > output.length) throw invalidArchive('DEFLATE output exceeds its declared size')
      output.set(bytes, outputOffset)
      outputOffset += bytes.length
      continue
    }
    if (type === 3) throw invalidArchive('Reserved DEFLATE block type')
    const [literalTable, distanceTable] = type === 1 ? fixedTables() : dynamicTables(reader)
    while (true) {
      if ((outputOffset & 0x3fff) === 0) throwIfCancelled(signal)
      const symbol = literalTable.decode(reader)
      if (symbol < 256) {
        if (outputOffset >= output.length) throw invalidArchive('DEFLATE output exceeds its declared size')
        output[outputOffset++] = symbol
        continue
      }
      if (symbol === 256) break
      const lengthIndex = symbol - 257
      const bases = deflate64 ? LENGTH_BASE_64 : LENGTH_BASE_32
      const extras = deflate64 ? LENGTH_EXTRA_64 : LENGTH_EXTRA_32
      if (lengthIndex < 0 || lengthIndex >= bases.length) throw invalidArchive('Invalid DEFLATE length symbol')
      const length = bases[lengthIndex] + reader.read(extras[lengthIndex])
      const distanceSymbol = distanceTable.decode(reader)
      const distanceLimit = deflate64 ? 32 : 30
      if (distanceSymbol < 0 || distanceSymbol >= distanceLimit) throw invalidArchive('Invalid DEFLATE distance symbol')
      const distance = DISTANCE_BASE[distanceSymbol] + reader.read(DISTANCE_EXTRA[distanceSymbol])
      if (distance > outputOffset) throw invalidArchive('DEFLATE match exceeds output history')
      if (outputOffset + length > output.length) throw invalidArchive('DEFLATE match exceeds its declared output size')
      for (let index = 0; index < length; index += 1) {
        output[outputOffset] = output[outputOffset - distance]
        outputOffset += 1
      }
    }
  }
  if (outputOffset !== output.length) throw invalidArchive('DEFLATE output size does not match the 7z header')
  return output
}
