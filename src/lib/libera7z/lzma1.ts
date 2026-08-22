import { uint64ToSafeNumber } from './binary'
import { invalidArchive } from './errors'
import { LzmaDecoder } from './lzma'

export interface Lzma1Properties {
  property: number
  dictionarySize: number
}

/** Parses the five-byte property block stored by the 7z LZMA coder. */
export function parseLzma1Properties(properties: Uint8Array): Lzma1Properties {
  if (properties.length !== 5) throw invalidArchive('LZMA coder properties are malformed')
  const dictionarySize = (
    properties[1] |
    (properties[2] << 8) |
    (properties[3] << 16) |
    (properties[4] << 24)
  ) >>> 0
  if (dictionarySize === 0) throw invalidArchive('LZMA dictionary size is zero')
  return {
    property: properties[0],
    dictionarySize: Math.max(4096, dictionarySize)
  }
}

/**
 * Decodes the raw range-coded stream used by an LZMA coder in a 7z folder.
 * The unpack size comes from CodersUnpackSize, so an end marker is not needed.
 */
export function decodeLzma1(
  input: Uint8Array,
  properties: Uint8Array,
  expectedSize: bigint | number,
  signal?: AbortSignal
): Uint8Array {
  const parsed = parseLzma1Properties(properties)
  const size = typeof expectedSize === 'bigint'
    ? uint64ToSafeNumber(expectedSize, 'LZMA output size')
    : expectedSize
  if (!Number.isSafeInteger(size) || size < 0) throw invalidArchive('Invalid LZMA output size')
  const decoder = new LzmaDecoder(parsed.dictionarySize)
  decoder.resetDictionary()
  decoder.setProperties(parsed.property)
  decoder.resetState()
  return decoder.decodeChunk(input, size, signal)
}
