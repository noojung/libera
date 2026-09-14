import path from 'path'
import { Transform } from 'stream'
import zlib from 'zlib'
import { decodeBzip2Blocks } from 'libera7z'
import { XzStreamDecoder } from './xz/reader'

// The codecs that wrap a single stream of bytes rather than carrying entries of
// their own. Each one shows up twice in this app - around a tarball, and on its
// own as `name.ext` - so the streams, the suffixes and what the inspector says
// about them live here instead of being restated at each call site.

export type StreamCodec = 'gzip' | 'xz' | 'bzip2' | 'zstd'

/**
 * Decodes xz as it arrives, so a `.tar.xz` is unpacked while it is read.
 */
export function createXzDecompressor(): Transform {
  const decoder = new XzStreamDecoder()
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))
        let decoded = decoder.pull()
        while (decoded) {
          this.push(Buffer.from(decoded))
          decoded = decoder.pull()
        }
        callback()
      } catch (error) {
        callback(error as Error)
      }
    },
    flush(callback) {
      try {
        decoder.end()
        callback()
      } catch (error) {
        callback(error as Error)
      }
    }
  })
}

/**
 * Decodes bzip2 a block at a time.
 *
 * Unlike xz, bzip2 gives no way to find where a block ends without decoding it,
 * so the compressed bytes are gathered before any are decoded. What is held is
 * the archive as it already exists on disk; the expansion - which is where a
 * bzip2 bomb does its damage - is handed on block by block and metered by the
 * caller like any other stream.
 */
export function createBzip2Decompressor(): Transform {
  const compressed: Buffer[] = []
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressed.push(chunk)
      callback()
    },
    flush(callback) {
      try {
        const input = Buffer.concat(compressed)
        compressed.length = 0
        // A block's own structure bounds how far it can expand, so the limit
        // that matters is the caller's, applied to the bytes as they land.
        for (const block of decodeBzip2Blocks(new Uint8Array(input), Number.MAX_SAFE_INTEGER)) {
          this.push(Buffer.from(block))
        }
        callback()
      } catch (error) {
        callback(error as Error)
      }
    }
  })
}

/**
 * Zstandard rides on Node's zlib bindings, which only carry it from Node 22.
 * The app pins a newer Node than that, so this is a guard for an embedder
 * rather than a branch the packaged app takes.
 */
export function supportsZstd(): boolean {
  return typeof zlib.createZstdCompress === 'function'
}

/** Maps the archive levels 0-9 onto the Zstandard levels 1-19. */
export function zstdLevel(level?: number): number {
  if (level === undefined) return 3
  return Math.max(1, Math.min(19, Math.round((level / 9) * 19)))
}

function requireZstd(): void {
  if (!supportsZstd()) throw new Error('Zstandard is unavailable in this runtime.')
}

/** Decodes one stream of the named codec, a chunk at a time. */
export function createCodecDecompressor(codec: StreamCodec): Transform {
  switch (codec) {
    case 'gzip': return zlib.createGunzip()
    case 'xz': return createXzDecompressor()
    case 'bzip2': return createBzip2Decompressor()
    case 'zstd':
      requireZstd()
      return zlib.createZstdDecompress()
  }
}

export interface CodecCompressorOptions {
  level?: number
  /** Deflate-only tuning, ignored by every other codec. */
  strategy?: number
  memLevel?: number
}

/**
 * Encodes one stream of the named codec. Only the two codecs this app writes
 * are here; xz and bzip2 are read-only, since neither has an encoder in the
 * TypeScript stack the rest of the app is built on.
 */
export function createCodecCompressor(
  codec: 'gzip' | 'zstd',
  options: CodecCompressorOptions = {}
): Transform {
  if (codec === 'zstd') {
    requireZstd()
    return zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel(options.level) }
    })
  }
  return zlib.createGzip({
    level: options.level,
    ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
    ...(options.memLevel !== undefined ? { memLevel: options.memLevel } : {})
  })
}

/** How the inspector names a codec and the stream it heads. */
export interface CodecDescription {
  /** What a single entry compressed with it is labelled. */
  entry: string
  /** How the whole stream is summarised in the header panel. */
  summary: string
  signature: string
  version: string
}

export const CODEC_DESCRIPTIONS: Record<StreamCodec, CodecDescription> = {
  gzip: {
    entry: 'Gzip (Deflate)',
    summary: 'Gzip / Deflate Stream',
    signature: '1F 8B (GZIP)',
    version: 'RFC 1952'
  },
  xz: {
    entry: 'XZ (LZMA2)',
    summary: 'XZ / LZMA2 Stream',
    signature: 'FD 37 7A 58 5A 00 (XZ)',
    version: 'XZ 1.0.4'
  },
  bzip2: {
    entry: 'BZip2',
    summary: 'BZip2 Stream',
    signature: '42 5A 68 (BZh)',
    version: 'BZip2 0.9.0'
  },
  zstd: {
    entry: 'Zstandard',
    summary: 'Zstandard Stream',
    signature: '28 B5 2F FD (ZSTD)',
    version: 'RFC 8878'
  }
}

/**
 * The suffix each codec carries when it wraps a lone file, longest first so a
 * lookup never stops at a shorter suffix that happens to match.
 */
const SINGLE_FILE_SUFFIXES: readonly (readonly [string, StreamCodec])[] = [
  ['.bz2', 'bzip2'],
  ['.zst', 'zstd'],
  ['.gz', 'gzip'],
  ['.xz', 'xz']
]

/** How each single-file codec is named in the format column. */
export const SINGLE_FILE_FORMAT_LABELS: Record<StreamCodec, string> = {
  gzip: 'GZ',
  xz: 'XZ',
  bzip2: 'BZ2',
  zstd: 'ZST'
}

/**
 * The codec wrapping a lone file, or null when the path names none.
 *
 * A `.tar.gz` is a tarball before it is a gzip stream, so callers offer the
 * path to the tar reader first; this only answers what the last suffix says.
 */
export function streamCodecFor(archivePath: string): StreamCodec | null {
  const normalized = archivePath.toLowerCase()
  const match = SINGLE_FILE_SUFFIXES.find(([suffix]) => normalized.endsWith(suffix))
  return match ? match[1] : null
}

/**
 * The name the single file inside a compressed stream is stored under.
 *
 * `path.basename(p, ext)` would do this, but it compares the suffix case
 * sensitively, so it leaves `FOO.GZ` whole and the lone entry ends up named
 * after the archive instead of the file in it.
 */
export function streamEntryName(archivePath: string): string {
  const baseName = path.basename(archivePath)
  const match = SINGLE_FILE_SUFFIXES.find(([suffix]) => baseName.toLowerCase().endsWith(suffix))
  if (!match) return baseName
  // A file called nothing but its own suffix keeps it, rather than stripping
  // down to a name no file can have.
  return baseName.slice(0, -match[0].length) || baseName
}
