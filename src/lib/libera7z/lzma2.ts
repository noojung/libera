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

/** What one LZMA2 control byte asks the decoder to do before its payload. */
export interface Lzma2ChunkPlan {
  kind: 'end' | 'uncompressed' | 'lzma'
  resetDictionary: boolean
  readProperties: boolean
  resetState: boolean
}

/** Reset bookkeeping carried between LZMA2 chunks. */
export interface Lzma2ChunkState {
  needsDictionaryReset: boolean
  needsProperties: boolean
  needsStateReset: boolean
}

export function initialLzma2ChunkState(): Lzma2ChunkState {
  return { needsDictionaryReset: true, needsProperties: true, needsStateReset: true }
}

/**
 * Reads one control byte and updates the reset bookkeeping, rejecting streams
 * that lean on state they never established.
 *
 * Only a dictionary-resetting uncompressed chunk (control 1) invalidates the
 * LZMA state and properties. Control 2 carries both across, which is what
 * 7-Zip emits when it drops to stored chunks partway through incompressible
 * data and then resumes with a plain 0x80 chunk. Demanding a reset after either
 * kind rejects archives that 7-Zip and liblzma both read.
 *
 * Shared by the buffered and streaming decoders so the rule cannot drift.
 */
export function planLzma2Chunk(control: number, state: Lzma2ChunkState): Lzma2ChunkPlan {
  if (control === 0) return { kind: 'end', resetDictionary: false, readProperties: false, resetState: false }

  if (control === 1 || control === 2) {
    const resetDictionary = control === 1
    if (resetDictionary) {
      state.needsDictionaryReset = false
      state.needsProperties = true
      state.needsStateReset = true
    } else if (state.needsDictionaryReset) {
      throw invalidArchive('LZMA2 stream uses the dictionary before resetting it')
    }
    return { kind: 'uncompressed', resetDictionary, readProperties: false, resetState: false }
  }

  if (control < 0x80) throw invalidArchive('Invalid LZMA2 control byte')

  const resetDictionary = control >= 0xe0
  const readProperties = control >= 0xc0
  const resetState = control >= 0xa0

  if (resetDictionary) state.needsDictionaryReset = false
  else if (state.needsDictionaryReset) {
    throw invalidArchive('LZMA2 compressed chunk appears before a dictionary reset')
  }
  if (readProperties) state.needsProperties = false
  else if (state.needsProperties) {
    throw invalidArchive('LZMA2 compressed chunk appears before coder properties')
  }
  if (resetState) state.needsStateReset = false
  else if (state.needsStateReset) {
    throw invalidArchive('LZMA2 compressed chunk appears before a state reset')
  }
  return { kind: 'lzma', resetDictionary, readProperties, resetState }
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
  const state = initialLzma2ChunkState()

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
    const plan = planLzma2Chunk(control, state)
    if (plan.kind === 'end') break
    if (plan.resetDictionary) decoder.resetDictionary()

    if (plan.kind === 'uncompressed') {
      const length = ((readByte() << 8) | readByte()) + 1
      const bytes = readBytes(length).slice()
      decoder.writeUncompressed(bytes)
      output.push(bytes)
      outputSize += bytes.length
      continue
    }

    const unpackedSize = (((control & 0x1f) << 16) | (readByte() << 8) | readByte()) + 1
    const packedSize = ((readByte() << 8) | readByte()) + 1
    if (plan.readProperties) decoder.setProperties(readByte())
    if (plan.resetState) decoder.resetState()

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
