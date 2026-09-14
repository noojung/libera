import fs from 'fs'
import path from 'path'
import { Transform } from 'stream'
import { createCodecDecompressor } from './codecStreams'

// What sits between a `.tar.<something>` on disk and the tar reader. The `tar`
// package finds gzip by itself, so only the codecs this app decodes on its own
// are named here; the streams themselves come from `codecStreams.ts`, which the
// lone-file readers share.

/** The suffixes that name a tar inside one of the codecs handled here. */
const XZ_TAR_SUFFIXES = ['.tar.xz', '.txz'] as const
const BZIP2_TAR_SUFFIXES = ['.tar.bz2', '.tbz2', '.tbz'] as const
const ZSTD_TAR_SUFFIXES = ['.tar.zst', '.tzst'] as const

/** The suffixes that name a tar the `tar` package unwraps without help. */
const GZIP_TAR_SUFFIXES = ['.tar.gz', '.tgz'] as const

export type TarCompression = 'xz' | 'bzip2' | 'zstd' | 'none'

/**
 * Which codec, if any, this app has to decode in front of the tarball.
 *
 * Gzip reads as `none` because the `tar` package unwraps it itself, so nothing
 * has to be put in the way. `tarInspectionFormat` is what tells a `.tar.gz`
 * from a bare `.tar`.
 */
export function tarCompressionFor(archivePath: string): TarCompression {
  const normalized = archivePath.toLowerCase()
  if (XZ_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'xz'
  if (BZIP2_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'bzip2'
  if (ZSTD_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))) return 'zstd'
  return 'none'
}

/** True when the path names a tarball the `tar` package gunzips for us. */
export function isGzipTarPath(archivePath: string): boolean {
  const normalized = archivePath.toLowerCase()
  return GZIP_TAR_SUFFIXES.some(suffix => normalized.endsWith(suffix))
}

/** True for any tar this app reads, whatever wraps it. */
export function isTarArchivePath(archivePath: string): boolean {
  const normalized = archivePath.toLowerCase()
  return path.extname(normalized) === '.tar' ||
    isGzipTarPath(normalized) ||
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
  if (compression === 'none') return [source]
  return [source, createCodecDecompressor(compression)]
}
