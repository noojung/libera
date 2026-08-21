import { concatBytes } from './binary'
import { invalidArchive, throwIfCancelled } from './errors'
import { encodeLzma, LzmaDecoder, type LzmaEncoderOptions } from './lzma'

const ENCODE_CHUNK_SIZE = 48 * 1024
const DEFAULT_LZMA_PROPERTIES = 93 // lc=3, lp=0, pb=2

export function dictionarySizeFromProperty(property: number): number {
  if (!Number.isInteger(property) || property < 0 || property > 40) {
    throw invalidArchive('Invalid LZMA2 dictionary property')
  }
  if (property === 40) return 0xffffffff
  return (2 | (property & 1)) * (2 ** ((property >>> 1) + 11))
}

export function dictionaryPropertyForSize(dictionarySize: number): number {
  if (!Number.isSafeInteger(dictionarySize) || dictionarySize < 4096) throw new RangeError('Invalid dictionary size')
  for (let property = 0; property < 40; property += 1) {
    if (dictionarySize <= dictionarySizeFromProperty(property)) return property
  }
  return 40
}

export interface Lzma2Encoded {
  data: Uint8Array
  compressedChunks: number
}

export const LZMA2_ENCODE_CHUNK_SIZE = ENCODE_CHUNK_SIZE

export function encodeLzma2Block(
  chunk: Uint8Array,
  options: LzmaEncoderOptions = {}
): { data: Uint8Array; compressed: boolean } {
  if (chunk.length < 1 || chunk.length > ENCODE_CHUNK_SIZE) throw new RangeError('Invalid LZMA2 encoder chunk size')
  const compressed = encodeLzma(chunk, undefined, options)
  const unpackedMinusOne = chunk.length - 1
  const packedMinusOne = compressed.length - 1

  if (compressed.length < chunk.length && compressed.length <= 0x10000) {
    return {
      data: concatBytes([
        Uint8Array.of(
          0xe0 | ((unpackedMinusOne >>> 16) & 0x1f),
          (unpackedMinusOne >>> 8) & 0xff,
          unpackedMinusOne & 0xff,
          (packedMinusOne >>> 8) & 0xff,
          packedMinusOne & 0xff,
          DEFAULT_LZMA_PROPERTIES
        ),
        compressed
      ]),
      compressed: true
    }
  }

  return {
    data: concatBytes([
      Uint8Array.of(0x01, (unpackedMinusOne >>> 8) & 0xff, unpackedMinusOne & 0xff),
      chunk
    ]),
    compressed: false
  }
}

export function encodeLzma2(input: Uint8Array, signal?: AbortSignal): Lzma2Encoded {
  const parts: Uint8Array[] = []
  let compressedChunks = 0

  for (let offset = 0; offset < input.length; offset += ENCODE_CHUNK_SIZE) {
    throwIfCancelled(signal)
    const chunk = input.subarray(offset, Math.min(input.length, offset + ENCODE_CHUNK_SIZE))
    const encoded = encodeLzma2Block(chunk)
    parts.push(encoded.data)
    if (encoded.compressed) compressedChunks += 1
  }
  parts.push(Uint8Array.of(0))
  return { data: concatBytes(parts), compressedChunks }
}

export function decodeLzma2(
  input: Uint8Array,
  dictionaryProperty: number,
  expectedSize?: number,
  signal?: AbortSignal
): Uint8Array {
  const dictionarySize = dictionarySizeFromProperty(dictionaryProperty)
  const decoder = new LzmaDecoder(dictionarySize)
  const output: Uint8Array[] = []
  let outputSize = 0
  let position = 0
  let needsDictionaryReset = true
  let needsProperties = true
  let needsStateReset = true

  const readByte = () => {
    if (position >= input.length) throw invalidArchive('Truncated LZMA2 stream')
    return input[position++]
  }
  const readBytes = (length: number) => {
    if (length < 0 || position + length > input.length) throw invalidArchive('Truncated LZMA2 chunk')
    const value = input.subarray(position, position + length)
    position += length
    return value
  }

  while (true) {
    throwIfCancelled(signal)
    const control = readByte()
    if (control === 0) break

    if (control === 1 || control === 2) {
      if (control === 1) {
        decoder.resetDictionary()
        needsDictionaryReset = false
      } else if (needsDictionaryReset) {
        throw invalidArchive('LZMA2 stream uses the dictionary before resetting it')
      }
      const length = ((readByte() << 8) | readByte()) + 1
      const bytes = readBytes(length).slice()
      decoder.writeUncompressed(bytes)
      output.push(bytes)
      outputSize += bytes.length
      needsStateReset = true
      continue
    }

    if (control < 0x80) throw invalidArchive('Invalid LZMA2 control byte')
    const resetsDictionary = control >= 0xe0
    const resetsState = control >= 0xa0
    const suppliesProperties = control >= 0xc0

    if (resetsDictionary) {
      decoder.resetDictionary()
      needsDictionaryReset = false
    } else if (needsDictionaryReset) {
      throw invalidArchive('LZMA2 compressed chunk appears before a dictionary reset')
    }

    const unpackedSize = (((control & 0x1f) << 16) | (readByte() << 8) | readByte()) + 1
    const packedSize = ((readByte() << 8) | readByte()) + 1
    if (suppliesProperties) {
      decoder.setProperties(readByte())
      needsProperties = false
    } else if (needsProperties) {
      throw invalidArchive('LZMA2 compressed chunk appears before coder properties')
    }
    if (resetsState) {
      decoder.resetState()
      needsStateReset = false
    } else if (needsStateReset) {
      throw invalidArchive('LZMA2 compressed chunk appears before a state reset')
    }

    const decoded = decoder.decodeChunk(readBytes(packedSize), unpackedSize, signal)
    output.push(decoded)
    outputSize += decoded.length
  }

  if (position !== input.length) throw invalidArchive('LZMA2 stream contains trailing bytes')
  if (expectedSize !== undefined && outputSize !== expectedSize) {
    throw invalidArchive(`LZMA2 stream expands to ${outputSize} bytes instead of ${expectedSize}`)
  }
  return concatBytes(output)
}
