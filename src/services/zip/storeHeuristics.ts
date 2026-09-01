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

/**
 * How much of the file is deflated at a time. Deflate matches within a 32 KiB
 * window, so a chunk this size is compressed to within a few bytes of what a
 * single pass over the whole file would produce - and chunking is what keeps
 * the answer synchronous and the memory flat, whatever the file weighs.
 */
const TRIAL_CHUNK = 1024 * 1024

/**
 * What a stored block costs to frame. zlib emits them 16 KiB at a time, so
 * incompressible input comes back about a third of a byte per KiB larger -
 * measured across levels 1 to 9 and sizes up to 16 MiB.
 */
const DEFLATE_BLOCK = 16 * 1024
const DEFLATE_BLOCK_OVERHEAD = 5

/**
 * The most deflate can make of these bytes. It falls back to stored blocks
 * rather than emit a block that grew, so the ceiling is the input plus that
 * framing - which is what lets the trial stop early once the savings so far
 * are more than the rest of the file could possibly waste.
 */
export function maxDeflatedSize(bytes: number): number {
  return bytes + DEFLATE_BLOCK_OVERHEAD * Math.ceil(bytes / DEFLATE_BLOCK) + 8
}

/**
 * Whether this entry should be stored rather than compressed: true when the
 * file is one of the formats that arrive compressed, and otherwise when
 * deflating it does not make it any smaller.
 *
 * Deflates the file to measure it, discarding the result - so the entry is
 * compressed twice when compression wins, and the trial stops as soon as the
 * verdict can no longer change.
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
    const chunk = Buffer.alloc(Math.min(size, TRIAL_CHUNK))
    let consumed = 0
    let deflated = 0
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, consumed)
      if (read === 0) break
      consumed += read
      deflated += zlib.deflateRawSync(chunk.subarray(0, read), { level }).length
      // Already smaller than the file can end up being: compress it.
      if (deflated + maxDeflatedSize(Math.max(0, size - consumed)) < size) return false
    }
    return deflated >= consumed
  } catch {
    return false
  } finally {
    fs.closeSync(handle)
  }
}
