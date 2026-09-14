import path from 'path'
import { compose, Transform, type Duplex } from 'stream'
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

/**
 * The search strategies Zstandard offers, weakest and fastest first. The names
 * are the codec's own, so what is picked here reads the same as it does in the
 * reference tool.
 */
export type ZstdStrategy =
  | 'fast' | 'dfast' | 'greedy' | 'lazy' | 'lazy2' | 'btlazy2' | 'btopt' | 'btultra' | 'btultra2'

const ZSTD_STRATEGIES: Record<ZstdStrategy, number> = {
  fast: zlib.constants.ZSTD_fast,
  dfast: zlib.constants.ZSTD_dfast,
  greedy: zlib.constants.ZSTD_greedy,
  lazy: zlib.constants.ZSTD_lazy,
  lazy2: zlib.constants.ZSTD_lazy2,
  btlazy2: zlib.constants.ZSTD_btlazy2,
  btopt: zlib.constants.ZSTD_btopt,
  btultra: zlib.constants.ZSTD_btultra,
  btultra2: zlib.constants.ZSTD_btultra2
}

export function isZstdStrategy(value: string): value is ZstdStrategy {
  return value in ZSTD_STRATEGIES
}

/**
 * The reach of the match window, as bytes rather than the log the codec takes.
 *
 * The ceiling is what a reader will accept rather than what the encoder can do:
 * a decoder allocates the whole window up front and refuses a frame asking for
 * more than its own limit, which is 128 MiB by default everywhere. Writing past
 * that would produce archives only a specially configured reader could open.
 */
export const ZSTD_MIN_WINDOW_SIZE = 1024 * 1024
export const ZSTD_MAX_WINDOW_SIZE = 128 * 1024 * 1024

/** The log the codec wants, for a window size already known to be legal. */
export function zstdWindowLog(windowSize: number): number {
  return Math.log2(windowSize)
}

export function isZstdWindowSize(windowSize: number): boolean {
  return Number.isInteger(windowSize) &&
    windowSize >= ZSTD_MIN_WINDOW_SIZE &&
    windowSize <= ZSTD_MAX_WINDOW_SIZE &&
    Number.isInteger(zstdWindowLog(windowSize))
}

/**
 * Threads the encoder may hand work to. Zero keeps it on the calling thread,
 * which is what the codec does when nothing asks otherwise.
 */
export const ZSTD_MAX_WORKERS = 16

export function isZstdWorkers(workers: number): boolean {
  return Number.isInteger(workers) && workers >= 0 && workers <= ZSTD_MAX_WORKERS
}

/**
 * The largest write handed to a worker-backed encoder.
 *
 * Node's binding drops the whole stream - no output, no error - when a single
 * write past about 16 MiB reaches a Zstandard encoder running workers. Every
 * caller here feeds it a read stream's chunks, which are far smaller, but the
 * encoder splits its input anyway so the failure cannot be reached by a caller
 * that one day hands it a whole buffer.
 */
const ZSTD_WORKER_WRITE_LIMIT = 4 * 1024 * 1024

/** Cuts oversized writes down before they reach a stream that cannot take them. */
function createWriteSplitter(limit: number): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (let offset = 0; offset < chunk.length; offset += limit) {
        this.push(chunk.subarray(offset, offset + limit))
      }
      callback()
    }
  })
}

/** What expert mode can say about a Zstandard stream beyond its level. */
export interface ZstdTuning {
  strategy?: ZstdStrategy
  windowSize?: number
  /**
   * Finds repeats further apart than the window reaches, cheaply, by indexing
   * the input coarsely alongside the ordinary match search.
   */
  longDistanceMatching?: boolean
  /** Threads the encoder hands blocks to; 0 keeps it on the calling thread. */
  workers?: number
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
  /** Zstandard-only tuning, ignored by every other codec. */
  zstd?: ZstdTuning
}

/**
 * The encoder settings for one Zstandard stream. The level goes in first and
 * the rest after, because each one set here replaces what the level implied.
 */
function zstdParams(level: number | undefined, tuning: ZstdTuning = {}): Record<number, number> {
  const params: Record<number, number> = {
    [zlib.constants.ZSTD_c_compressionLevel]: zstdLevel(level)
  }
  if (tuning.strategy) params[zlib.constants.ZSTD_c_strategy] = ZSTD_STRATEGIES[tuning.strategy]
  if (tuning.windowSize) params[zlib.constants.ZSTD_c_windowLog] = zstdWindowLog(tuning.windowSize)
  if (tuning.longDistanceMatching) params[zlib.constants.ZSTD_c_enableLongDistanceMatching] = 1
  if (tuning.workers) params[zlib.constants.ZSTD_c_nbWorkers] = tuning.workers
  return params
}

/**
 * Encodes one stream of the named codec. Only the two codecs this app writes
 * are here; xz and bzip2 are read-only, since neither has an encoder in the
 * TypeScript stack the rest of the app is built on.
 */
export function createCodecCompressor(
  codec: 'gzip' | 'zstd',
  options: CodecCompressorOptions = {}
): Duplex {
  if (codec === 'zstd') {
    requireZstd()
    const encoder = zlib.createZstdCompress({ params: zstdParams(options.level, options.zstd) })
    if (!options.zstd?.workers) return encoder
    return compose(createWriteSplitter(ZSTD_WORKER_WRITE_LIMIT), encoder)
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
