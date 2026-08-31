import { invalidArchive, throwIfCancelled } from './errors'

export type SevenZipFilter =
  | 'bcj'
  | 'ppc'
  | 'ia64'
  | 'arm'
  | 'armt'
  | 'sparc'
  | 'arm64'
  | 'riscv'
  | 'delta'
  | 'swap2'
  | 'swap4'

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value
  bytes[offset + 1] = value >>> 8
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value
  bytes[offset + 1] = value >>> 8
  bytes[offset + 2] = value >>> 16
  bytes[offset + 3] = value >>> 24
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24
  bytes[offset + 1] = value >>> 16
  bytes[offset + 2] = value >>> 8
  bytes[offset + 3] = value
}

function parseStartPosition(properties: Uint8Array): number {
  if (properties.length === 0) return 0
  if (properties.length !== 4) throw invalidArchive('Branch filter properties are malformed')
  return readUint32LE(properties, 0)
}

function decodeDelta(bytes: Uint8Array, properties: Uint8Array): void {
  if (properties.length !== 1) throw invalidArchive('Delta filter properties are malformed')
  const distance = properties[0] + 1
  for (let index = distance; index < bytes.length; index += 1) {
    bytes[index] = (bytes[index] + bytes[index - distance]) & 0xff
  }
}

function decodeSwap(bytes: Uint8Array, width: 2 | 4, properties: Uint8Array): void {
  if (properties.length !== 0) throw invalidArchive('Swap filter has unexpected properties')
  for (let offset = 0; offset + width <= bytes.length; offset += width) {
    for (let left = 0, right = width - 1; left < right; left += 1, right -= 1) {
      const temporary = bytes[offset + left]
      bytes[offset + left] = bytes[offset + right]
      bytes[offset + right] = temporary
    }
  }
}

const X86_MASK_TO_ALLOWED = [true, true, true, false, true, false, false, false]
const X86_MASK_TO_BIT_NUMBER = [0, 1, 2, 2, 3, 3, 3, 3]

function x86ConvertibleMsByte(value: number): boolean {
  return value === 0 || value === 0xff
}

function decodeX86(bytes: Uint8Array, startPosition: number): void {
  let position = 0
  let previousPosition = -1
  let previousMask = 0
  while (position + 4 < bytes.length) {
    const opcode = bytes[position]
    if ((opcode & 0xfe) !== 0xe8) {
      position += 1
      continue
    }

    const distance = position - previousPosition
    if (distance > 3) {
      previousMask = 0
    } else {
      previousMask = (previousMask << (distance - 1)) & 7
      if (previousMask !== 0) {
        const checkByte = bytes[position + 4 - X86_MASK_TO_BIT_NUMBER[previousMask]]
        if (!X86_MASK_TO_ALLOWED[previousMask] || x86ConvertibleMsByte(checkByte)) {
          previousPosition = position
          previousMask = ((previousMask << 1) | 1) & 7
          position += 1
          continue
        }
      }
    }

    previousPosition = position
    if (x86ConvertibleMsByte(bytes[position + 4])) {
      let source = readUint32LE(bytes, position + 1)
      let destination: number
      while (true) {
        destination = (source - (startPosition + position + 5)) >>> 0
        if (previousMask === 0) break
        const bitNumber = X86_MASK_TO_BIT_NUMBER[previousMask] * 8
        if (!x86ConvertibleMsByte(destination >>> (24 - bitNumber))) break
        source = (destination ^ ((1 << (32 - bitNumber)) - 1)) >>> 0
      }
      destination = ((destination! & 0x00ffffff) - (destination! & 0x01000000)) >>> 0
      writeUint32LE(bytes, position + 1, destination)
      position += 5
      previousMask = 0
    } else {
      previousMask = ((previousMask << 1) | 1) & 7
      position += 1
    }
  }
}

function decodeArm(bytes: Uint8Array, startPosition: number): void {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    if (bytes[offset + 3] !== 0xeb) continue
    let value = readUint32LE(bytes, offset)
    value = (value - ((startPosition + offset + 8) >>> 2)) >>> 0
    writeUint32LE(bytes, offset, (value & 0x00ffffff) | 0xeb000000)
  }
}

function decodeArmThumb(bytes: Uint8Array, startPosition: number): void {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 2) {
    const first = readUint16LE(bytes, offset)
    const second = readUint16LE(bytes, offset + 2)
    if ((first & 0xf800) !== 0xf000 || (second & 0xf800) !== 0xf800) continue
    let value = ((first << 11) | (second & 0x7ff)) >>> 0
    value = (value - ((startPosition + offset + 4) >>> 1)) >>> 0
    writeUint16LE(bytes, offset, ((value >>> 11) & 0x7ff) | 0xf000)
    writeUint16LE(bytes, offset + 2, (value & 0x7ff) | 0xf800)
    offset += 2
  }
}

function decodePpc(bytes: Uint8Array, startPosition: number): void {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    let value = readUint32BE(bytes, offset)
    if ((value & 0xfc000003) !== 0x48000001) continue
    value = (value - (startPosition + offset)) >>> 0
    writeUint32BE(bytes, offset, (value & 0x03ffffff) | 0x48000000)
  }
}

function decodeSparc(bytes: Uint8Array, startPosition: number): void {
  const flag = 1 << 22
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    let value = readUint32BE(bytes, offset)
    value = (((((value + (5 << 29)) >>> 0) ^ (7 << 29)) + flag) >>> 0)
    if ((value & ((0 - (flag << 1)) >>> 0)) !== 0) continue
    value = (value << 2) >>> 0
    value = (value - (startPosition + offset)) >>> 0
    value &= (flag << 3) - 1
    value = (value - (flag << 2)) >>> 2
    value |= 1 << 30
    writeUint32BE(bytes, offset, value)
  }
}

function decodeArm64(bytes: Uint8Array, startPosition: number): void {
  const flag = 1 << 20
  const mask = (1 << 24) - (flag << 1)
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
    let value = readUint32LE(bytes, offset)
    const position = (startPosition + offset) >>> 0
    if ((((value - 0x94000000) >>> 0) & 0xfc000000) === 0) {
      value = (value - (position >>> 2)) >>> 0
      writeUint32LE(bytes, offset, (value & 0x03ffffff) | 0x94000000)
      continue
    }
    value = (value - 0x90000000) >>> 0
    if ((value & 0x9f000000) !== 0) continue
    value = (value + flag) >>> 0
    if ((value & mask) !== 0) continue
    let address = ((value & 0xffffffe0) | (value >>> 26)) >>> 0
    address = (address - ((position >>> 9) & ~7)) >>> 0
    value = (value & 0x1f) | 0x90000000
    value |= address << 26
    value |= 0x00ffffe0 & (((address & ((flag << 1) - 1)) - flag) >>> 0)
    writeUint32LE(bytes, offset, value)
  }
}

function decodeIa64(bytes: Uint8Array, startPosition: number): void {
  let pc = ((startPosition - 16) >>> 3) >>> 0
  for (let bundle = 0; bundle + 16 <= bytes.length; bundle += 16) {
    let mask = (0x334b0000 >>> (bytes[bundle] & 0x1e)) & 3
    pc = (pc + 2) >>> 0
    while (mask !== 0) {
      const offset = bundle + mask * 5 - 4
      const first = readUint32LE(bytes, offset)
      let value = readUint32LE(bytes, offset + 1) >>> mask
      if (((first >>> mask) & 0xe0) === 0 && (((value - 0x0a000000) >>> 0) & 0x1e000000) === 0) {
        let branch = value & 0x011fffff
        value ^= branch
        const extendedPc = (pc | (~0x003fffff)) >>> 0
        branch = (branch - extendedPc) >>> 0
        branch &= ~0x00c00000
        branch = (branch + 0x00e00000) & 0x011fffff
        value |= branch
        value = (value << mask) >>> 0
        writeUint32LE(bytes, offset + 1, value)
      }
      mask = (mask + 1) & 3
    }
  }
}

function decodeRiscV(bytes: Uint8Array, startPosition: number): void {
  let offset = 0
  while (offset + 8 <= bytes.length) {
    const marker = ((readUint16LE(bytes, offset) ^ 0x10) + 1) >>> 0
    if ((marker & 0x77) !== 0) {
      offset += 2
      continue
    }
    let instruction = readUint32LE(bytes, offset)
    if ((marker & 8) === 0) {
      const adjusted = (marker - 0x100) >>> 0
      if ((adjusted & 0xd80) !== 0) {
        offset += 2
        continue
      }
      let value = (bytes[offset + 3] << 1) | (bytes[offset + 2] << 9) | ((adjusted & 0xf000) << 5)
      value = (value - (startPosition + offset)) >>> 0
      instruction = ((adjusted + 0xef) & 0xfff) |
        ((value << 11) & 0x80000000) |
        ((value << 20) & 0x7fe00000) |
        ((value << 9) & 0x00100000) |
        (value & 0x000ff000)
      writeUint32LE(bytes, offset, instruction)
      offset += 4
      continue
    }
    const register = instruction >>> 27
    const second = readUint32LE(bytes, offset + 4)
    const checkPair = (value: number, registerValue: number): boolean =>
      ((((value - ((3 << 12) | (2 << 7) | 8)) << 18) >>> 0) < (registerValue & 0x1d))
    if ((marker & 0xe80) === 0 && checkPair(marker, register)) {
      let address = readUint32BE(bytes, offset + 4)
      const low = instruction >>> 12
      address = (address - (startPosition + offset)) >>> 0
      instruction = ((register << 7) + 0x17 + ((address + 0x800) & 0xfffff000)) >>> 0
      writeUint32LE(bytes, offset, instruction)
      writeUint32LE(bytes, offset + 4, (low | (address << 20)) >>> 0)
      offset += 8
      continue
    }
    const pairMatches = ((((second - 3) ^ (marker << 8)) & 0xf8003) === 0)
    if ((marker & 0xe80) !== 0 && pairMatches) {
      const value = ((instruction & 0xfffff000) | (second >>> 20)) >>> 0
      writeUint32LE(bytes, offset, ((second << 12) | 0x117) >>> 0)
      writeUint32LE(bytes, offset + 4, value)
      offset += 8
      continue
    }
    offset += (marker & 0xe80) === 0 ? 4 : 6
  }
}

export function decodeSevenZipFilter(
  filter: SevenZipFilter,
  input: Uint8Array,
  properties: Uint8Array,
  signal?: AbortSignal
): Uint8Array {
  throwIfCancelled(signal)
  const result = input.slice()
  if (filter === 'delta') decodeDelta(result, properties)
  else if (filter === 'swap2') decodeSwap(result, 2, properties)
  else if (filter === 'swap4') decodeSwap(result, 4, properties)
  else {
    const startPosition = parseStartPosition(properties)
    if (filter === 'bcj') decodeX86(result, startPosition)
    else if (filter === 'ppc') decodePpc(result, startPosition)
    else if (filter === 'ia64') decodeIa64(result, startPosition)
    else if (filter === 'arm') decodeArm(result, startPosition)
    else if (filter === 'armt') decodeArmThumb(result, startPosition)
    else if (filter === 'sparc') decodeSparc(result, startPosition)
    else if (filter === 'arm64') decodeArm64(result, startPosition)
    else decodeRiscV(result, startPosition)
  }
  throwIfCancelled(signal)
  return result
}
