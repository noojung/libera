import { Duplex } from 'stream'
import zlib from 'zlib'
import { registerCodec } from '@zip.js/zip.js'
import { LzmaStreamDecoder, LzmaStreamEncoder, parseLzma1Properties } from 'libera7z'

// Method numbers as they appear in a ZIP entry header. Store (0), Deflate (8),
// Deflate64 (9) and AES (99) are zip.js built-ins and cannot be re-registered.
export const ZIP_LZMA_METHOD = 14
export const ZIP_ZSTD_METHOD = 93

/**
 * The largest dictionary an LZMA entry declares. A decoder allocates the whole
 * dictionary up front, so the encoder is held to the same reach rather than
 * letting a big entry ask every reader for a matching allocation.
 */
const LZMA_MAX_DICTIONARY_SIZE = 16 * 1024 * 1024
const LZMA_MIN_DICTIONARY_SIZE = 4096
/** lc=3, lp=0, pb=2 - the LZMA defaults, and what `encodeLzma` encodes with. */
const LZMA_PROPERTY_BYTE = 0x5d
/** LZMA SDK version stamped into the entry header. Readers ignore it. */
const LZMA_SDK_VERSION = [9, 20]
/** Decoded slices allowed to sit between the decoder and its reader. */
const OUTPUT_SLICES_IN_FLIGHT = 4

/** General purpose bit 1 marks an LZMA stream that ends in an EOS marker. */
const LZMA_EOS_FLAG = 0x02

interface TransformStreamLike {
  readable: ReadableStream
  writable: WritableStream
}

/** Rounds up to a power of two so the declared size is one LZMA accepts. */
function lzmaDictionarySize(inputSize: number): number {
  let size = LZMA_MIN_DICTIONARY_SIZE
  while (size < inputSize && size < LZMA_MAX_DICTIONARY_SIZE) size *= 2
  return size
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/**
 * A ZIP LZMA entry opens with a 4 byte header - SDK version and property size
 * - followed by the 5 property bytes and then the raw LZMA stream. No
 * end-of-stream marker is written, so readers stop at the declared size.
 */
function lzmaHeader(dictionarySize: number): Uint8Array {
  return Uint8Array.of(
    LZMA_SDK_VERSION[0],
    LZMA_SDK_VERSION[1],
    5,
    0,
    LZMA_PROPERTY_BYTE,
    dictionarySize & 0xff,
    (dictionarySize >>> 8) & 0xff,
    (dictionarySize >>> 16) & 0xff,
    (dictionarySize >>> 24) & 0xff
  )
}

/** Spends the archive level 1-9 on how hard the match finder looks. */
function lzmaEffort(level?: number): { searchDepth: number; niceLength: number } {
  const effort = Math.max(1, Math.min(9, level ?? 6))
  return {
    searchDepth: effort * 32,
    niceLength: Math.min(273, effort * 32)
  }
}

class LzmaCompressionStream implements TransformStreamLike {
  readable: ReadableStream
  writable: WritableStream

  constructor(_format: string, options: { level?: number; uncompressedSize?: number } = {}) {
    // The dictionary goes in the header, ahead of any data, so it is sized
    // from the declared entry size. An undeclared size takes the maximum.
    const dictionarySize = lzmaDictionarySize(options.uncompressedSize ?? LZMA_MAX_DICTIONARY_SIZE)
    const encoder = new LzmaStreamEncoder(undefined, {
      ...lzmaEffort(options.level),
      maxDistance: dictionarySize
    })
    let headerSent = false
    const sendHeader = (controller: TransformStreamDefaultController<Uint8Array>): void => {
      if (headerSent) return
      controller.enqueue(lzmaHeader(dictionarySize))
      headerSent = true
    }
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sendHeader(controller)
        const encoded = encoder.update(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
        if (encoded.length > 0) controller.enqueue(encoded)
      },
      flush(controller) {
        sendHeader(controller)
        controller.enqueue(encoder.final())
      }
    }) as TransformStreamLike
    this.readable = stream.readable
    this.writable = stream.writable
  }
}

class LzmaDecompressionStream implements TransformStreamLike {
  readable: ReadableStream
  writable: WritableStream

  constructor(_format: string, options: { uncompressedSize?: number; rawBitFlag?: number } = {}) {
    const { uncompressedSize } = options
    if (uncompressedSize === undefined) {
      // Without a size the decoder cannot tell payload from the padding that
      // follows it, and this writer never emits the marker that would.
      throw new Error(((options.rawBitFlag ?? 0) & LZMA_EOS_FLAG)
        ? 'LZMA entries with an end-of-stream marker and no declared size are unsupported.'
        : 'The LZMA entry does not declare its uncompressed size.')
    }

    // The header arrives ahead of the stream, so the first bytes are held
    // until the properties it carries are complete.
    let header: Uint8Array = new Uint8Array(0)
    let decoder: LzmaStreamDecoder | undefined

    const open = (chunk: Uint8Array): Uint8Array | undefined => {
      header = concatChunks([header, chunk], header.length + chunk.length) as Uint8Array
      if (header.length < 4) return undefined
      const propertiesSize = header[2] | (header[3] << 8)
      if (propertiesSize !== 5) throw new Error('The LZMA entry properties are malformed.')
      if (header.length < 4 + propertiesSize) return undefined
      const properties = header.subarray(4, 4 + propertiesSize)
      const { property, dictionarySize } = parseLzma1Properties(properties)
      // The dictionary is allocated whole, and the header is the archive's
      // word for how big it is. A match can never reach past the output, so
      // an entry that declares more than it produces is held to its size.
      const bounded = Math.max(4096, Math.min(dictionarySize, uncompressedSize))
      decoder = new LzmaStreamDecoder(bounded, property, uncompressedSize)
      return header.subarray(4 + propertiesSize)
    }

    // Pulled a slice at a time, waiting whenever the reader falls behind: a
    // little input can decode to a great deal of output, and enqueuing it all
    // would put the entry back in memory, which is what streaming avoids.
    const drain = async (controller: TransformStreamDefaultController<Uint8Array>): Promise<void> => {
      for (let slice = decoder!.pull(); slice; slice = decoder!.pull()) {
        controller.enqueue(slice)
        while ((controller.desiredSize ?? 1) <= 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        let body = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        if (!decoder) {
          const rest = open(body)
          if (rest === undefined) return
          body = rest
        }
        decoder!.push(body)
        await drain(controller)
      },
      async flush(controller) {
        if (!decoder) throw new Error('The LZMA entry header is truncated.')
        decoder.end()
        await drain(controller)
        decoder.assertComplete()
      }
    // The readable side needs room of its own: with the default of zero,
    // `desiredSize` never rises above zero and the wait below never ends.
    }, undefined, { highWaterMark: OUTPUT_SLICES_IN_FLIGHT }) as TransformStreamLike
    this.readable = stream.readable
    this.writable = stream.writable
  }
}

/** Maps the archive levels 1-9 onto the Zstandard levels 1-19. */
function zstdLevel(level?: number): number {
  if (level === undefined) return 3
  return Math.max(1, Math.min(19, Math.round((level / 9) * 19)))
}

function webTransform(duplex: Duplex): TransformStreamLike {
  return Duplex.toWeb(duplex) as unknown as TransformStreamLike
}

class ZstdCompressionStream implements TransformStreamLike {
  readable: ReadableStream
  writable: WritableStream

  constructor(_format: string, options: { level?: number } = {}) {
    const stream = webTransform(zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel(options.level) }
    }))
    this.readable = stream.readable
    this.writable = stream.writable
  }
}

class ZstdDecompressionStream implements TransformStreamLike {
  readable: ReadableStream
  writable: WritableStream

  constructor() {
    const stream = webTransform(zlib.createZstdDecompress())
    this.readable = stream.readable
    this.writable = stream.writable
  }
}

/** Zstandard rides on Node's zlib bindings, which only carry it from Node 22. */
export function supportsZstd(): boolean {
  return typeof zlib.createZstdCompress === 'function'
}

let registered = false

/**
 * Teaches zip.js the methods this app writes beyond Store and Deflate. Both
 * the readers and the writers call it, so an archive stays openable by the app
 * that produced it.
 */
export function registerZipCodecs(): void {
  if (registered) return
  registered = true

  registerCodec({
    compressionMethod: ZIP_LZMA_METHOD,
    format: 'lzma',
    CompressionStream: LzmaCompressionStream as never,
    DecompressionStream: LzmaDecompressionStream as never
  })

  if (!supportsZstd()) return
  registerCodec({
    compressionMethod: ZIP_ZSTD_METHOD,
    format: 'zstd',
    CompressionStream: ZstdCompressionStream as never,
    DecompressionStream: ZstdDecompressionStream as never
  })
}
