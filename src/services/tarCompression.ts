import fs from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { decodeBzip2Blocks } from 'libera7z'
import { XzStreamDecoder } from './xz/reader'

// What sits between a `.tar.<something>` on disk and the tar reader. The `tar`
// package finds gzip by itself, so only the two this app decodes in TypeScript
// are here.

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

/** The suffixes that name a tar inside one of the codecs handled here. */
const XZ_TAR_SUFFIXES = ['.tar.xz', '.txz'] as const
const BZIP2_TAR_SUFFIXES = ['.tar.bz2', '.tbz2', '.tbz'] as const

export type TarCompression = 'xz' | 'bzip2' | 'none'

/** Which codec, if any, wraps the tar at this path. */
export function tarCompressionFor(archivePath: string): TarCompression {
  const normalized = archivePath.toLowerCase()
  if (XZ_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'xz'
  if (BZIP2_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'bzip2'
  return 'none'
}

/** True for any tar this app reads, whatever wraps it. */
export function isTarArchivePath(archivePath: string): boolean {
  const normalized = archivePath.toLowerCase()
  return path.extname(normalized) === '.tar' ||
    normalized.endsWith('.tgz') ||
    normalized.endsWith('.tar.gz') ||
    tarCompressionFor(normalized) !== 'none'
}

/**
 * The stages a tar is read through: the file, and the decoder its suffix calls
 * for. `tar` handles gzip on its own, so that one adds nothing here.
 */
export function tarReadStages(
  archivePath: string,
  options?: { start?: number; end?: number }
): [fs.ReadStream, ...Transform[]] {
  const source = fs.createReadStream(archivePath, options)
  const compression = tarCompressionFor(archivePath)
  if (compression === 'xz') return [source, createXzDecompressor()]
  if (compression === 'bzip2') return [source, createBzip2Decompressor()]
  return [source]
}
