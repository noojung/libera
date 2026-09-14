import fs from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { createCodecDecompressor, type StreamCodec } from './codecStreams'

// What sits between a `.tar.<something>` on disk and the tar reader.
//
// The `tar` package sniffs the leading bytes and unwraps gzip and Zstandard
// itself, so those two need nothing put in front of them; xz and bzip2 it does
// not know, and those are decoded here from the streams in `codecStreams.ts`
// that the lone-file readers share.

/** The suffixes that name a tar inside one of the codecs handled here. */
const XZ_TAR_SUFFIXES = ['.tar.xz', '.txz'] as const
const BZIP2_TAR_SUFFIXES = ['.tar.bz2', '.tbz2', '.tbz'] as const
const ZSTD_TAR_SUFFIXES = ['.tar.zst', '.tzst'] as const
const GZIP_TAR_SUFFIXES = ['.tar.gz', '.tgz'] as const

/** Which codec a suffix says is wrapped around the tarball, whoever decodes it. */
const TAR_WRAPPERS: readonly (readonly [readonly string[], StreamCodec])[] = [
  [XZ_TAR_SUFFIXES, 'xz'],
  [BZIP2_TAR_SUFFIXES, 'bzip2'],
  [ZSTD_TAR_SUFFIXES, 'zstd'],
  [GZIP_TAR_SUFFIXES, 'gzip']
]

/** The codecs the `tar` package recognises from the bytes and unwraps itself. */
const SELF_UNWRAPPED: readonly StreamCodec[] = ['gzip', 'zstd']

export type TarCompression = 'xz' | 'bzip2' | 'none'

/**
 * The codec wrapped around a tarball, or null for a bare one. This names what
 * the file is; `tarCompressionFor` is what decides who decodes it.
 */
export function tarWrapperFor(archivePath: string): StreamCodec | null {
  const normalized = archivePath.toLowerCase()
  const match = TAR_WRAPPERS.find(([suffixes]) => suffixes.some(suffix => normalized.endsWith(suffix)))
  return match ? match[1] : null
}

/**
 * Which codec, if any, this app has to decode in front of the tarball.
 *
 * Gzip and Zstandard read as `none`: the `tar` package finds both from their
 * leading bytes and unwraps them, so putting a decoder in the way would be
 * decoding what has already been decoded.
 */
export function tarCompressionFor(archivePath: string): TarCompression {
  const wrapper = tarWrapperFor(archivePath)
  if (wrapper === null || SELF_UNWRAPPED.includes(wrapper)) return 'none'
  return wrapper === 'xz' ? 'xz' : 'bzip2'
}

/** True for any tar this app reads, whatever wraps it. */
export function isTarArchivePath(archivePath: string): boolean {
  const normalized = archivePath.toLowerCase()
  return path.extname(normalized) === '.tar' || tarWrapperFor(normalized) !== null
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
  if (compression === 'none') return [source]
  return [source, createCodecDecompressor(compression)]
}
