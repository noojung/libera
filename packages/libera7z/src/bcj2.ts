import { invalidArchive, throwIfCancelled } from './errors.js'

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0
}

function startPosition(properties: Uint8Array): number {
  if (properties.length === 0) return 0
  if (properties.length !== 4) throw invalidArchive('BCJ2 properties are malformed')
  return (properties[0] | (properties[1] << 8) | (properties[2] << 16) | (properties[3] << 24)) >>> 0
}

export function decodeBcj2(
  inputs: readonly Uint8Array[],
  properties: Uint8Array,
  expectedSize: number,
  signal?: AbortSignal
): Uint8Array {
  if (inputs.length !== 4) throw invalidArchive('BCJ2 requires four input streams')
  const [main, calls, jumps, rangeBytes] = inputs
  if ((calls.length & 3) !== 0 || (jumps.length & 3) !== 0) {
    throw invalidArchive('BCJ2 address streams are malformed')
  }
  if (main.length + calls.length + jumps.length !== expectedSize) {
    throw invalidArchive('BCJ2 stream sizes do not match the declared output')
  }
  if (rangeBytes.length < 5 || rangeBytes[0] !== 0) throw invalidArchive('BCJ2 range stream is malformed')
  let code = 0
  for (let index = 0; index < 5; index += 1) code = ((code << 8) | rangeBytes[index]) >>> 0
  if (code === 0xffffffff) throw invalidArchive('BCJ2 range stream is malformed')
  let range = 0xffffffff
  let rangeOffset = 5
  const probabilities = new Uint16Array(258).fill(1024)
  const output = new Uint8Array(expectedSize)
  let outputOffset = 0
  let mainOffset = 0
  let callOffset = 0
  let jumpOffset = 0
  let instructionPosition = startPosition(properties)
  let previousByte = 0

  const normalize = (): void => {
    if (range >= 1 << 24) return
    if (rangeOffset >= rangeBytes.length) throw invalidArchive('Truncated BCJ2 range stream')
    range = (range << 8) >>> 0
    code = ((code << 8) | rangeBytes[rangeOffset++]) >>> 0
  }

  while (mainOffset < main.length) {
    if ((outputOffset & 0x3fff) === 0) throwIfCancelled(signal)
    normalize()
    const byte = main[mainOffset++]
    if (outputOffset >= output.length) throw invalidArchive('BCJ2 output exceeds its declared size')
    output[outputOffset++] = byte
    instructionPosition = (instructionPosition + 1) >>> 0
    const isCall = byte === 0xe8
    const isJump = byte === 0xe9
    const isConditionalJump = previousByte === 0x0f && (byte & 0xf0) === 0x80
    if (!isCall && !isJump && !isConditionalJump) {
      previousByte = byte
      continue
    }

    const probabilityIndex = isCall ? 2 + previousByte : isJump ? 1 : 0
    let probability = probabilities[probabilityIndex]
    const bound = Math.imul(range >>> 11, probability) >>> 0
    if (code < bound) {
      range = bound
      probability += (2048 - probability) >>> 5
      probabilities[probabilityIndex] = probability
      previousByte = byte
      continue
    }
    range = (range - bound) >>> 0
    code = (code - bound) >>> 0
    probability -= probability >>> 5
    probabilities[probabilityIndex] = probability

    const addressStream = isCall ? calls : jumps
    const addressOffset = isCall ? callOffset : jumpOffset
    if (addressOffset + 4 > addressStream.length || outputOffset + 4 > output.length) {
      throw invalidArchive('Truncated BCJ2 address stream')
    }
    let value = readUint32BE(addressStream, addressOffset)
    if (isCall) callOffset += 4
    else jumpOffset += 4
    value = (value - (instructionPosition + 4)) >>> 0
    output[outputOffset++] = value
    output[outputOffset++] = value >>> 8
    output[outputOffset++] = value >>> 16
    output[outputOffset++] = value >>> 24
    instructionPosition = (instructionPosition + 4) >>> 0
    previousByte = value >>> 24
  }
  if (outputOffset !== output.length || callOffset !== calls.length || jumpOffset !== jumps.length) {
    throw invalidArchive('BCJ2 streams do not end together')
  }
  throwIfCancelled(signal)
  return output
}
