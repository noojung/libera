import { invalidArchive, throwIfCancelled } from './errors.js'

class MsbBitReader {
  private offset = 0
  private bits = 0
  private bitCount = 0

  constructor(private readonly input: Uint8Array) {}

  read(count: number): number {
    if (count < 0 || count > 24) throw new RangeError('Invalid BZip2 bit count')
    while (this.bitCount < count) {
      if (this.offset >= this.input.length) throw invalidArchive('Truncated BZip2 stream')
      this.bits = ((this.bits << 8) | this.input[this.offset++]) >>> 0
      this.bitCount += 8
    }
    this.bitCount -= count
    const mask = count === 0 ? 0 : count === 24 ? 0xffffff : (1 << count) - 1
    return (this.bits >>> this.bitCount) & mask
  }
}

class BzipHuffmanTable {
  private readonly symbols = new Map<number, number>()
  private readonly maximumLength: number

  constructor(lengths: readonly number[]) {
    this.maximumLength = Math.max(0, ...lengths)
    if (this.maximumLength > 20 || lengths.some(length => length < 1 || length > 20)) {
      throw invalidArchive('Invalid BZip2 Huffman lengths')
    }
    const counts = new Uint32Array(this.maximumLength + 1)
    for (const length of lengths) counts[length] += 1
    const next = new Uint32Array(this.maximumLength + 1)
    let code = 0
    for (let length = 1; length <= this.maximumLength; length += 1) {
      code = (code + counts[length - 1]) << 1
      if (code + counts[length] > (1 << length)) throw invalidArchive('Oversubscribed BZip2 Huffman tree')
      next[length] = code
    }
    lengths.forEach((length, symbol) => {
      this.symbols.set((length << 21) | next[length]++, symbol)
    })
  }

  decode(reader: MsbBitReader): number {
    let code = 0
    for (let length = 1; length <= this.maximumLength; length += 1) {
      code = (code << 1) | reader.read(1)
      const symbol = this.symbols.get((length << 21) | code)
      if (symbol !== undefined) return symbol
    }
    throw invalidArchive('Invalid BZip2 Huffman symbol')
  }
}

const BZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) !== 0
        ? ((value << 1) ^ 0x04c11db7) >>> 0
        : (value << 1) >>> 0
    }
    table[index] = value
  }
  return table
})()

function bzipCrc(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = ((value << 8) ^ BZIP_CRC_TABLE[((value >>> 24) ^ byte) & 0xff]) >>> 0
  return (value ^ 0xffffffff) >>> 0
}

function readUint32(reader: MsbBitReader): number {
  return ((reader.read(16) << 16) | reader.read(16)) >>> 0
}

function readMagic(reader: MsbBitReader): [number, number] {
  return [reader.read(24), reader.read(24)]
}

function readSymbolMap(reader: MsbBitReader): number[] {
  const groupMap = reader.read(16)
  const symbols: number[] = []
  for (let group = 0; group < 16; group += 1) {
    if ((groupMap & (1 << (15 - group))) === 0) continue
    const map = reader.read(16)
    for (let index = 0; index < 16; index += 1) {
      if ((map & (1 << (15 - index))) !== 0) symbols.push(group * 16 + index)
    }
  }
  if (symbols.length === 0) throw invalidArchive('BZip2 block has an empty symbol map')
  return symbols
}

function readSelectors(reader: MsbBitReader, groupCount: number): number[] {
  const count = reader.read(15)
  if (count < 1 || count > 18002) throw invalidArchive('Invalid BZip2 selector count')
  const moveToFront = Array.from({ length: groupCount }, (_, index) => index)
  return Array.from({ length: count }, () => {
    let index = 0
    while (reader.read(1) !== 0) {
      index += 1
      if (index >= groupCount) throw invalidArchive('Invalid BZip2 selector')
    }
    const selected = moveToFront[index]
    moveToFront.splice(index, 1)
    moveToFront.unshift(selected)
    return selected
  })
}

function readHuffmanTables(reader: MsbBitReader, groupCount: number, alphabetSize: number): BzipHuffmanTable[] {
  return Array.from({ length: groupCount }, () => {
    let length = reader.read(5)
    const lengths: number[] = []
    for (let symbol = 0; symbol < alphabetSize; symbol += 1) {
      while (reader.read(1) !== 0) {
        length += reader.read(1) === 0 ? 1 : -1
        if (length < 1 || length > 20) throw invalidArchive('Invalid BZip2 Huffman length delta')
      }
      lengths.push(length)
    }
    return new BzipHuffmanTable(lengths)
  })
}

function decodeHuffmanData(
  reader: MsbBitReader,
  symbols: readonly number[],
  selectors: readonly number[],
  tables: readonly BzipHuffmanTable[],
  blockLimit: number,
  signal?: AbortSignal
): Uint8Array {
  const endSymbol = symbols.length + 1
  const moveToFront = [...symbols]
  const output: number[] = []
  let selectorIndex = 0
  let groupRemaining = 0
  let table: BzipHuffmanTable | undefined
  const nextSymbol = (): number => {
    if (groupRemaining === 0) {
      if (selectorIndex >= selectors.length) throw invalidArchive('BZip2 selectors end before the block')
      table = tables[selectors[selectorIndex++]]
      groupRemaining = 50
    }
    groupRemaining -= 1
    return table!.decode(reader)
  }

  let symbol = nextSymbol()
  while (symbol !== endSymbol) {
    if ((output.length & 0x3fff) === 0) throwIfCancelled(signal)
    if (symbol === 0 || symbol === 1) {
      let repeat = -1
      let weight = 1
      do {
        repeat += symbol === 0 ? weight : weight << 1
        if (weight > blockLimit) throw invalidArchive('BZip2 run exceeds the block limit')
        weight <<= 1
        symbol = nextSymbol()
      } while (symbol === 0 || symbol === 1)
      repeat += 1
      if (output.length + repeat > blockLimit) throw invalidArchive('BZip2 block exceeds its declared size')
      for (let index = 0; index < repeat; index += 1) output.push(moveToFront[0])
      if (symbol === endSymbol) break
    }
    const index = symbol - 1
    if (index < 1 || index >= moveToFront.length) throw invalidArchive('Invalid BZip2 move-to-front symbol')
    const value = moveToFront[index]
    moveToFront.splice(index, 1)
    moveToFront.unshift(value)
    output.push(value)
    if (output.length > blockLimit) throw invalidArchive('BZip2 block exceeds its declared size')
    symbol = nextSymbol()
  }
  return Uint8Array.from(output)
}

function inverseBurrowsWheeler(lastColumn: Uint8Array, originalPointer: number): Uint8Array {
  if (lastColumn.length === 0 || originalPointer < 0 || originalPointer >= lastColumn.length) {
    throw invalidArchive('Invalid BZip2 original pointer')
  }
  const counts = new Uint32Array(257)
  for (const byte of lastColumn) counts[byte + 1] += 1
  for (let index = 1; index < counts.length; index += 1) counts[index] += counts[index - 1]
  const positions = new Uint32Array(lastColumn.length)
  for (let index = 0; index < lastColumn.length; index += 1) {
    positions[counts[lastColumn[index]]++] = index
  }
  const result = new Uint8Array(lastColumn.length)
  let position = positions[originalPointer]
  for (let index = 0; index < result.length; index += 1) {
    result[index] = lastColumn[position]
    position = positions[position]
  }
  return result
}

function decodeRunLength(input: Uint8Array, remainingOutput: number, signal?: AbortSignal): Uint8Array {
  const output: number[] = []
  let index = 0
  while (index < input.length) {
    if ((index & 0x3fff) === 0) throwIfCancelled(signal)
    const value = input[index++]
    output.push(value)
    let run = 1
    while (run < 4 && index < input.length && input[index] === value) {
      output.push(value)
      index += 1
      run += 1
    }
    if (run === 4) {
      if (index >= input.length) throw invalidArchive('Truncated BZip2 run length')
      const repeat = input[index++]
      if (output.length + repeat > remainingOutput) throw invalidArchive('BZip2 output exceeds its declared size')
      for (let count = 0; count < repeat; count += 1) output.push(value)
    }
    if (output.length > remainingOutput) throw invalidArchive('BZip2 output exceeds its declared size')
  }
  return Uint8Array.from(output)
}

export function decodeBzip2(input: Uint8Array, expectedSize: number, signal?: AbortSignal): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw invalidArchive('Invalid BZip2 output size')
  const reader = new MsbBitReader(input)
  if (reader.read(8) !== 0x42 || reader.read(8) !== 0x5a || reader.read(8) !== 0x68) {
    throw invalidArchive('Invalid BZip2 stream signature')
  }
  const blockSizeDigit = reader.read(8)
  if (blockSizeDigit < 0x31 || blockSizeDigit > 0x39) throw invalidArchive('Invalid BZip2 block size')
  const blockLimit = (blockSizeDigit - 0x30) * 100_000
  const chunks: Uint8Array[] = []
  let outputSize = 0
  let combinedCrc = 0
  while (true) {
    throwIfCancelled(signal)
    const [magicHigh, magicLow] = readMagic(reader)
    if (magicHigh === 0x177245 && magicLow === 0x385090) {
      if (readUint32(reader) !== combinedCrc) throw invalidArchive('BZip2 combined CRC does not match')
      break
    }
    if (magicHigh !== 0x314159 || magicLow !== 0x265359) throw invalidArchive('Invalid BZip2 block signature')
    const expectedCrc = readUint32(reader)
    if (reader.read(1) !== 0) throw invalidArchive('Randomized BZip2 blocks are unsupported')
    const originalPointer = reader.read(24)
    const symbols = readSymbolMap(reader)
    const groupCount = reader.read(3)
    if (groupCount < 2 || groupCount > 6) throw invalidArchive('Invalid BZip2 Huffman group count')
    const selectors = readSelectors(reader, groupCount)
    const tables = readHuffmanTables(reader, groupCount, symbols.length + 2)
    const lastColumn = decodeHuffmanData(reader, symbols, selectors, tables, blockLimit, signal)
    const block = decodeRunLength(
      inverseBurrowsWheeler(lastColumn, originalPointer),
      expectedSize - outputSize,
      signal
    )
    if (bzipCrc(block) !== expectedCrc) throw invalidArchive('BZip2 block CRC does not match')
    chunks.push(block)
    outputSize += block.length
    combinedCrc = ((((combinedCrc << 1) | (combinedCrc >>> 31)) >>> 0) ^ expectedCrc) >>> 0
  }
  if (outputSize !== expectedSize) throw invalidArchive('BZip2 output size does not match the 7z header')
  const result = new Uint8Array(outputSize)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
