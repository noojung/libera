import fs from 'fs'
import zlib from 'zlib'

// ZIP names a compression method per entry, so an archive can deflate what
// shrinks and store what does not. Two kinds of file are worth storing: one
// whose bytes are already a compressed stream, and one so small that deflate's
// own framing costs more than it saves. Both are decided by deflating a sample
// of the file rather than by reading its name - an extension is a claim about
// the contents, and the contents are right here to be read.

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
