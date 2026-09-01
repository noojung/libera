import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

// ZIP names a compression method per entry, so an archive can deflate what
// shrinks and store what does not. Two kinds of file are worth storing: one
// whose bytes are already a compressed stream, and one so small that deflate's
// own framing costs more than it saves.
//
// A format that carries its own compression is taken at its name. Deflate can
// still find a few percent in some of them - a flat-coloured JPEG or a small
// PNG will give up five to ten - but paying a pass over every byte of a photo
// library to shave a rounding error off it is the wrong trade. Everything else
// is decided by deflating a sample, because there the name says nothing.

/** Formats that arrive compressed, so the archive leaves them as they are. */
const PRECOMPRESSED_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'jpe', 'jp2', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'jxl',
  // Audio
  'mp3', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'wma',
  // Video
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp',
  // Archives and compressed streams
  'zip', 'zipx', '7z', 'rar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz',
  'zst', 'lz4', 'lzma', 'br', 'cab', 'arj',
  // Containers that are themselves ZIPs
  'jar', 'war', 'ear', 'apk', 'ipa', 'crx', 'whl', 'epub',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'
])

/** Whether the name ends in a format that ships its own compression. */
export function isPrecompressedName(name: string): boolean {
  return PRECOMPRESSED_EXTENSIONS.has(path.extname(name).slice(1).toLowerCase())
}

/** One sample window. Three of them are read from a file too big to judge whole. */
const WINDOW_BYTES = 32 * 1024
const WINDOW_COUNT = 3

/**
 * How much of a file is deflated to judge the rest of it. A file this size or
 * smaller is judged whole, which is what makes the answer exact for the small
 * files that deflate would grow.
 */
export const PROBE_BYTES = WINDOW_BYTES * WINDOW_COUNT

/**
 * Savings below this are not worth a deflate stream: the entry then costs a
 * pass over every byte on the way in and another on the way out, and readers
 * that could have mapped the bytes straight out of the archive no longer can.
 */
const MIN_SAVINGS = 0.02

/**
 * Where the sample windows start. A container's header often compresses well
 * even when its payload cannot - an MP4's metadata ahead of its video, a JPEG's
 * tables ahead of its scan - so the middle and the tail get a vote too, and
 * each window votes on its own rather than being averaged in with the others:
 * a header far smaller than one window would otherwise carry the whole file.
 */
export function probeOffsets(size: number): number[] {
  if (size <= PROBE_BYTES) return [0]
  const last = size - WINDOW_BYTES
  return Array.from({ length: WINDOW_COUNT }, (_, index) =>
    Math.floor((last * index) / (WINDOW_COUNT - 1))
  )
}

/**
 * Whether deflating this sample pays for itself. Empty input counts as
 * incompressible so a zero byte file skips the codec entirely.
 */
export function sampleResistsDeflate(sample: Uint8Array, level: number): boolean {
  if (sample.length === 0) return true
  const deflated = zlib.deflateRawSync(sample, { level }).length
  return deflated >= sample.length * (1 - MIN_SAVINGS)
}

/**
 * Whether this entry should be stored rather than compressed. Reads and
 * deflates a sample, so it is only asked about files the archive is about to
 * read in full anyway.
 *
 * Synchronous on purpose: archiver decides an entry's method inside a
 * synchronous callback on its directory walk, and one answer shared by every
 * writer beats two that could drift apart.
 */
export function shouldStoreEntry(filePath: string, size: number, level: number): boolean {
  if (level <= 0) return true
  if (size === 0) return true
  if (isPrecompressedName(filePath)) return true

  let handle: number
  try {
    handle = fs.openSync(filePath, 'r')
  } catch {
    // Unreadable here is not a verdict: leave the file to the writer, which
    // reports the failure or skips the entry as it normally would.
    return false
  }
  try {
    const offsets = probeOffsets(size)
    const windowSize = offsets.length === 1 ? Math.min(size, PROBE_BYTES) : WINDOW_BYTES
    const window = Buffer.alloc(windowSize)
    let resisting = 0
    for (const offset of offsets) {
      const read = fs.readSync(handle, window, 0, windowSize, offset)
      if (read > 0 && sampleResistsDeflate(window.subarray(0, read), level)) resisting += 1
    }
    // Store when most of the file resists it, not when all of it does.
    return resisting * 2 >= offsets.length
  } catch {
    return false
  } finally {
    fs.closeSync(handle)
  }
}
